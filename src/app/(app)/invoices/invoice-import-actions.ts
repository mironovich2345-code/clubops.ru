"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope, recordAudit } from "@/lib/access";
import { EXPENSE_CATEGORY_OPTIONS } from "@/lib/expenses";
import { getClubLegalEntities, normalizeEntityType } from "@/lib/legal-entities";
import { isUploadedFile } from "@/lib/uploaded-file";
import {
  readSheetRows,
  resolveColumns,
  parseDateCell,
  parseAmountCell,
  matchClubByName,
  isBlankRow,
  norm,
  newSummary,
  DUPLICATE_ROW_ISSUE,
  type ImportActionState,
  type ColumnSpec,
} from "@/lib/excel-import";
import {
  fileSha256,
  findDuplicateFileBatch,
  createImportBatch,
  finalizeImportBatch,
  loadInvoiceDupKeys,
  invoiceDupKey,
} from "@/lib/import-batches";
import { makeMonthCloseChecker, MONTH_CLOSED_ERROR } from "@/lib/month-close";

const COLUMNS: ColumnSpec[] = [
  { key: "invoiceDate", headers: ["Дата счёта", "Дата"], required: true },
  { key: "club", headers: ["Клуб"], required: true },
  { key: "legalEntity", headers: ["Юрлицо", "Юр. лицо"] },
  { key: "supplier", headers: ["Поставщик"] },
  { key: "supplierInn", headers: ["ИНН поставщика"] },
  { key: "supplierKpp", headers: ["КПП поставщика"] },
  { key: "supplierBank", headers: ["Банк поставщика"] },
  { key: "bik", headers: ["БИК"] },
  { key: "account", headers: ["Расчётный счёт", "Расчетный счет"] },
  { key: "corrAccount", headers: ["Корр. счёт", "Корр счет", "Корреспондентский счёт"] },
  { key: "payer", headers: ["Плательщик"] },
  { key: "payerInn", headers: ["ИНН плательщика"] },
  { key: "invoiceNumber", headers: ["Номер счёта", "Номер счета", "№ счёта"] },
  { key: "amount", headers: ["Сумма"], required: true },
  { key: "category", headers: ["Статья расходов", "Статья"] },
  { key: "expensePeriod", headers: ["Период расхода"] },
  { key: "dueDate", headers: ["Срок оплаты"] },
  { key: "paidDate", headers: ["Дата оплаты"] },
  { key: "comment", headers: ["Комментарий"] },
];

const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const CATEGORY_BY_LABEL = new Map<string, string>();
for (const o of EXPENSE_CATEGORY_OPTIONS) {
  CATEGORY_BY_LABEL.set(norm(o.label), o.key);
  CATEGORY_BY_LABEL.set(norm(o.key), o.key);
}

/**
 * Import supplier invoices from an Excel/CSV file. Imported invoices start as
 * `needs_review` and are NEVER marked paid (so they do not count toward budget
 * until approved/paid through the normal workflow). Amounts ≥ 0; legal entity, if
 * provided, must be attached to the club. Valid rows import even if others fail.
 * Manager/regional only, scope-restricted.
 */
export async function importInvoices(
  _prev: ImportActionState | undefined,
  formData: FormData,
): Promise<ImportActionState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "invoices")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Импортировать счета могут управляющие и региональные директора" };
  }

  const fileEntry = formData.get("file");
  if (!isUploadedFile(fileEntry) || fileEntry.size === 0) {
    return { ok: false, error: "Выберите файл (.xlsx, .xls или .csv)" };
  }

  let buffer: Buffer;
  let rows: unknown[][];
  try {
    buffer = Buffer.from(await fileEntry.arrayBuffer());
    rows = readSheetRows(buffer);
  } catch {
    return { ok: false, error: "Не удалось прочитать файл. Поддерживаются .xlsx, .xls, .csv" };
  }
  if (rows.length < 2) return { ok: false, error: "Файл пустой или содержит только заголовок" };

  const { index, missing } = resolveColumns(rows[0], COLUMNS);
  if (missing.length > 0) {
    return { ok: false, error: `В файле не найдены столбцы: ${missing.join(", ")}` };
  }

  const companyId = ctx.selectedCompanyId;

  // Part 2: block re-import of the exact same file (by hash).
  const fileHash = fileSha256(buffer);
  const prior = await findDuplicateFileBatch(companyId, "invoices", fileHash);
  if (prior) {
    const by = (await prisma.user.findUnique({ where: { id: prior.createdByUserId }, select: { name: true } }))?.name ?? "—";
    await recordAudit({
      action: "import.duplicate_file_blocked",
      entityType: "ImportBatch",
      companyId,
      userId: ctx.user.id,
      metadata: { type: "invoices", fileName: fileEntry.name, fileHash },
    });
    return {
      ok: false,
      error: "Этот файл уже загружался ранее. Повторная загрузка заблокирована.",
      blocked: { at: prior.createdAt.toISOString(), by },
    };
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope);

  const result = newSummary();
  const isClosed = makeMonthCloseChecker(companyId);
  const entityListCache = new Map<string, Awaited<ReturnType<typeof getClubLegalEntities>>>();
  // Part 3: existing + in-file invoice duplicate keys.
  const dupKeys = await loadInvoiceDupKeys(companyId, scope.clubIds);
  const batchId = await createImportBatch({
    companyId,
    clubId: scope.club?.id ?? null,
    type: "invoices",
    fileName: fileEntry.name,
    fileHash,
    createdByUserId: ctx.user.id,
  });

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (isBlankRow(row)) continue;
    result.processed++;
    const rowNo = i + 1;
    const at = (key: string) => (index[key] === undefined ? null : row[index[key]]);
    const text = (key: string) => String(at(key) ?? "").trim() || null;
    const clubLabel = String(at("club") ?? "").trim() || "—";

    const { club, ambiguous } = matchClubByName(clubs, at("club"));
    if (ambiguous) {
      result.errors.push({ row: rowNo, club: clubLabel, field: "Клуб", issue: "Несколько клубов с таким названием" });
      continue;
    }
    if (!club) {
      result.errors.push({ row: rowNo, club: clubLabel, field: "Клуб", issue: "Клуб не найден в доступной компании" });
      continue;
    }

    const amountParsed = parseAmountCell(at("amount"));
    if (amountParsed.empty) {
      result.errors.push({ row: rowNo, club: club.name, field: "Сумма", issue: "Укажите сумму" });
      continue;
    }
    if (amountParsed.error || (amountParsed.value ?? 0) < 0) {
      result.errors.push({ row: rowNo, club: club.name, field: "Сумма", issue: "Сумма должна быть неотрицательным числом" });
      continue;
    }
    const amountKopeks = rublesToKopeks(amountParsed.value!);

    // Dates: invoiceDate required, dueDate optional. Provided-but-invalid → error.
    const invoiceDate = parseDateCell(at("invoiceDate"));
    if (!invoiceDate) {
      result.errors.push({ row: rowNo, club: club.name, field: "Дата счёта", issue: "Неверный формат даты" });
      continue;
    }
    if (await isClosed(club.id, invoiceDate)) {
      result.errors.push({ row: rowNo, club: club.name, field: "Месяц", issue: MONTH_CLOSED_ERROR });
      continue;
    }
    let dueDate: Date | null = null;
    if (at("dueDate") != null && String(at("dueDate")).trim() !== "") {
      dueDate = parseDateCell(at("dueDate"));
      if (!dueDate) {
        result.errors.push({ row: rowNo, club: club.name, field: "Срок оплаты", issue: "Неверный формат даты" });
        continue;
      }
    }
    // Part 4: paid date — if present, the invoice is imported as already paid and
    // immediately counts in expenses / budget / analytics.
    let paidAt: Date | null = null;
    if (at("paidDate") != null && String(at("paidDate")).trim() !== "") {
      paidAt = parseDateCell(at("paidDate"));
      if (!paidAt) {
        result.errors.push({ row: rowNo, club: club.name, field: "Дата оплаты", issue: "Неверный формат даты" });
        continue;
      }
    }

    // Expense period (Part 4): use the column if given, else derive from
    // invoiceDate → paidAt → createdAt.
    const periodCell = String(at("expensePeriod") ?? "").trim();
    const expensePeriod = /^\d{4}-\d{2}$/.test(periodCell) ? periodCell : monthOf(invoiceDate ?? paidAt ?? new Date());

    // Category optional; if provided it must be a known category.
    let expenseCategory: string | null = null;
    if (at("category") != null && String(at("category")).trim() !== "") {
      const c = CATEGORY_BY_LABEL.get(norm(at("category")));
      if (!c) {
        result.errors.push({ row: rowNo, club: club.name, field: "Статья расходов", issue: "Неизвестная статья расходов" });
        continue;
      }
      expenseCategory = c;
    }

    // Legal entity optional; if provided it must be attached to the club.
    let legalEntityId: string | null = null;
    let chosenEntityInn: string | null = null;
    if (at("legalEntity") != null && String(at("legalEntity")).trim() !== "") {
      let attached = entityListCache.get(club.id);
      if (!attached) {
        attached = await getClubLegalEntities(club.id);
        entityListCache.set(club.id, attached);
      }
      const cell = at("legalEntity");
      const wantType = normalizeEntityType(String(cell));
      const match = attached.find(
        (e) => norm(e.name) === norm(cell) || (wantType && normalizeEntityType(e.type) === wantType),
      );
      if (!match) {
        result.errors.push({ row: rowNo, club: club.name, field: "Юрлицо", issue: "Юрлицо не привязано к клубу" });
        continue;
      }
      legalEntityId = match.id;
      chosenEntityInn = match.inn;
    }

    // Payer-vs-entity mismatch is a non-blocking warning appended to the comment.
    const payerInn = text("payerInn");
    let comment = text("comment");
    if (payerInn && chosenEntityInn && norm(payerInn) !== norm(chosenEntityInn)) {
      const warn = `⚠ ИНН плательщика (${payerInn}) не совпадает с юрлицом клуба (${chosenEntityInn})`;
      comment = comment ? `${comment}\n${warn}` : warn;
    }

    // Part 3: skip the row if an identical invoice already exists (or is repeated
    // earlier in this file). Does not block the rest of the file.
    const counterpartyName = text("supplier");
    const invoiceNumber = text("invoiceNumber");
    const key = invoiceDupKey({ companyId: club.companyId, clubId: club.id, invoiceDate, amountKopeks, counterpartyName, invoiceNumber, legalEntityId });
    if (dupKeys.has(key)) {
      result.duplicates.push({ row: rowNo, club: club.name, field: "Дубль", issue: DUPLICATE_ROW_ISSUE });
      continue;
    }
    dupKeys.add(key);

    const invoice = await prisma.invoice.create({
      data: {
        companyId: club.companyId,
        clubId: club.id,
        createdByUserId: ctx.user.id,
        legalEntityId,
        importBatchId: batchId,
        counterpartyName,
        counterpartyInn: text("supplierInn"),
        counterpartyKpp: text("supplierKpp"),
        counterpartyBankName: text("supplierBank"),
        counterpartyBankBik: text("bik"),
        counterpartyAccount: text("account"),
        counterpartyCorrAccount: text("corrAccount"),
        payerName: text("payer"),
        payerInn,
        amountKopeks,
        currency: "RUB",
        expenseCategory,
        expensePeriod,
        invoiceNumber,
        invoiceDate,
        dueDate,
        paidAt,
        // With a paid date → paid immediately; otherwise the normal review flow.
        status: paidAt ? "paid" : "needs_review",
        confidence: "low",
        comment,
      },
    });
    result.created++;

    await recordAudit({
      action: "invoice.created",
      entityType: "Invoice",
      entityId: invoice.id,
      companyId: club.companyId,
      clubId: club.id,
      userId: ctx.user.id,
      metadata: { source: "excel_import", amountKopeks, status: invoice.status },
    });
  }

  await finalizeImportBatch(
    batchId,
    { created: result.created, skipped: result.skipped, duplicated: result.duplicates.length, errored: result.errors.length },
    { processed: result.processed },
  );
  if (result.duplicates.length > 0) {
    await recordAudit({
      action: "import.row_duplicate_skipped",
      entityType: "ImportBatch",
      entityId: batchId,
      companyId,
      userId: ctx.user.id,
      metadata: { type: "invoices", count: result.duplicates.length, rows: result.duplicates.map((d) => d.row) },
    });
  }
  await recordAudit({
    action: "import.created",
    entityType: "ImportBatch",
    entityId: batchId,
    companyId,
    clubId: scope.club?.id ?? null,
    userId: ctx.user.id,
    metadata: {
      type: "invoices",
      fileName: fileEntry.name,
      fileHash,
      created: result.created,
      skipped: result.skipped,
      duplicated: result.duplicates.length,
      errored: result.errors.length,
    },
  });

  revalidatePath("/invoices");
  return { ok: true, result };
}
