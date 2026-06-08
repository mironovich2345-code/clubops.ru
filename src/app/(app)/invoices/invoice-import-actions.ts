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
  type ImportActionState,
  type ColumnSpec,
} from "@/lib/excel-import";

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
  { key: "dueDate", headers: ["Срок оплаты"] },
  { key: "comment", headers: ["Комментарий"] },
];

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

  let rows: unknown[][];
  try {
    rows = readSheetRows(Buffer.from(await fileEntry.arrayBuffer()));
  } catch {
    return { ok: false, error: "Не удалось прочитать файл. Поддерживаются .xlsx, .xls, .csv" };
  }
  if (rows.length < 2) return { ok: false, error: "Файл пустой или содержит только заголовок" };

  const { index, missing } = resolveColumns(rows[0], COLUMNS);
  if (missing.length > 0) {
    return { ok: false, error: `В файле не найдены столбцы: ${missing.join(", ")}` };
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope);
  const companyId = ctx.selectedCompanyId;

  const result = newSummary();
  const entityListCache = new Map<string, Awaited<ReturnType<typeof getClubLegalEntities>>>();

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
    let dueDate: Date | null = null;
    if (at("dueDate") != null && String(at("dueDate")).trim() !== "") {
      dueDate = parseDateCell(at("dueDate"));
      if (!dueDate) {
        result.errors.push({ row: rowNo, club: club.name, field: "Срок оплаты", issue: "Неверный формат даты" });
        continue;
      }
    }

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

    const invoice = await prisma.invoice.create({
      data: {
        companyId: club.companyId,
        clubId: club.id,
        createdByUserId: ctx.user.id,
        legalEntityId,
        counterpartyName: text("supplier"),
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
        invoiceNumber: text("invoiceNumber"),
        invoiceDate,
        dueDate,
        // Imported invoices are never auto-approved or paid.
        status: "needs_review",
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

  await recordAudit({
    action: "invoice.imported",
    entityType: "Invoice",
    companyId,
    userId: ctx.user.id,
    metadata: { processed: result.processed, created: result.created, errors: result.errors.length },
  });

  revalidatePath("/invoices");
  return { ok: true, result };
}
