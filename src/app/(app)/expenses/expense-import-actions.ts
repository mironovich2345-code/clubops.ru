"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import { getCurrentAccessContext, getCurrentCompanyAndClub, getClubsInScope, recordAudit } from "@/lib/access";
import { EXPENSE_CATEGORY_OPTIONS, PAYMENT_METHOD_OPTIONS, EXPENSE_TYPE_LABELS } from "@/lib/expenses";
import { evaluateExpenseBudget, currentMonthKey, SOURCE_STATUS_WAITING } from "@/lib/budgets";
import { getClubEntityByType, getClubLegalEntities, normalizeEntityType } from "@/lib/legal-entities";
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
  findActiveExpenseFileBatch,
  createImportBatch,
  finalizeImportBatch,
  loadExpenseDupKeys,
  expenseDupKey,
} from "@/lib/import-batches";

const COLUMNS: ColumnSpec[] = [
  { key: "date", headers: ["Дата"], required: true },
  { key: "club", headers: ["Клуб"], required: true },
  { key: "category", headers: ["Статья", "Статья расходов"], required: true },
  { key: "type", headers: ["Тип"] },
  { key: "paymentMethod", headers: ["Способ оплаты"] },
  { key: "legalEntity", headers: ["Юрлицо", "Юр. лицо"] },
  { key: "vendor", headers: ["Контрагент / магазин / получатель", "Контрагент", "Получатель"] },
  { key: "amount", headers: ["Сумма"], required: true },
  { key: "comment", headers: ["Комментарий"] },
];

const CATEGORY_BY_LABEL = new Map<string, string>();
for (const o of EXPENSE_CATEGORY_OPTIONS) {
  CATEGORY_BY_LABEL.set(norm(o.label), o.key);
  CATEGORY_BY_LABEL.set(norm(o.key), o.key);
}
const METHOD_BY_LABEL = new Map<string, string>();
for (const o of PAYMENT_METHOD_OPTIONS) {
  METHOD_BY_LABEL.set(norm(o.label), o.key);
  METHOD_BY_LABEL.set(norm(o.key), o.key);
}
const TYPE_BY_LABEL = new Map<string, string>();
for (const [key, label] of Object.entries(EXPENSE_TYPE_LABELS)) {
  TYPE_BY_LABEL.set(norm(label), key);
  TYPE_BY_LABEL.set(norm(key), key);
}

/**
 * Import expenses from an Excel/CSV file. Mirrors the manual create flow per row:
 * cash → club's ИП (error if none), non-cash legal entity must be attached to the
 * club, amounts ≥ 0, status confirmed unless a budget overrun routes it to
 * waiting_budget_approval (with an approval request). Valid rows import even if
 * others fail. Manager/regional only, scope-restricted.
 */
export async function importExpenses(
  _prev: ImportActionState | undefined,
  formData: FormData,
): Promise<ImportActionState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "expenses")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Импортировать расходы могут управляющие и региональные директора" };
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

  // Part 1: block re-import of the same file only while a previous import of it
  // still has ACTIVE rows. Once all imported rows are canceled/reverted, allow it.
  const fileHash = fileSha256(buffer);
  const prior = await findActiveExpenseFileBatch(companyId, fileHash);
  if (prior) {
    const by = (await prisma.user.findUnique({ where: { id: prior.createdByUserId }, select: { name: true } }))?.name ?? "—";
    await recordAudit({
      action: "import.duplicate_file_blocked",
      entityType: "ImportBatch",
      companyId,
      userId: ctx.user.id,
      metadata: { type: "expenses", fileName: fileEntry.name, fileHash },
    });
    return {
      ok: false,
      error: "Этот файл уже загружался ранее, и активные строки из него ещё существуют.",
      blocked: { at: prior.createdAt.toISOString(), by },
    };
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope);

  const result = newSummary();
  let budgetPending = 0;
  const entityListCache = new Map<string, Awaited<ReturnType<typeof getClubLegalEntities>>>();
  const ipCache = new Map<string, string | null>();
  // Part 3: existing + in-file expense duplicate keys.
  const dupKeys = await loadExpenseDupKeys(companyId, scope.clubIds);
  const batchId = await createImportBatch({
    companyId,
    clubId: scope.club?.id ?? null,
    type: "expenses",
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

    const expenseDate = parseDateCell(at("date"));
    if (!expenseDate) {
      result.errors.push({ row: rowNo, club: club.name, field: "Дата", issue: "Неверный формат даты" });
      continue;
    }

    const category = CATEGORY_BY_LABEL.get(norm(at("category")));
    if (!category) {
      result.errors.push({ row: rowNo, club: club.name, field: "Статья", issue: "Неизвестная статья расходов" });
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

    // Payment method: empty → null; provided must be recognized.
    const methodCell = at("paymentMethod");
    let paymentMethod: string | null = null;
    if (methodCell != null && String(methodCell).trim() !== "") {
      const m = METHOD_BY_LABEL.get(norm(methodCell));
      if (!m) {
        result.errors.push({ row: rowNo, club: club.name, field: "Способ оплаты", issue: "Неизвестный способ оплаты" });
        continue;
      }
      paymentMethod = m;
    }

    const typeCell = at("type");
    const type = (typeCell != null && TYPE_BY_LABEL.get(norm(typeCell))) || "manual";

    // Legal-entity routing (identical rules to the manual form).
    let legalEntityId: string | null = null;
    if (paymentMethod === "cash") {
      let ipId = ipCache.get(club.id);
      if (ipId === undefined) {
        const ip = await getClubEntityByType(club.id, "ip");
        ipId = ip?.id ?? null;
        ipCache.set(club.id, ipId);
      }
      if (!ipId) {
        result.errors.push({ row: rowNo, club: club.name, field: "Способ оплаты", issue: "Для наличного расхода нужен ИП, привязанный к клубу" });
        continue;
      }
      legalEntityId = ipId;
    } else {
      const entCell = at("legalEntity");
      if (entCell != null && String(entCell).trim() !== "") {
        let attached = entityListCache.get(club.id);
        if (!attached) {
          attached = await getClubLegalEntities(club.id);
          entityListCache.set(club.id, attached);
        }
        const wantType = normalizeEntityType(String(entCell));
        const match = attached.find(
          (e) => norm(e.name) === norm(entCell) || (wantType && normalizeEntityType(e.type) === wantType),
        );
        if (!match) {
          result.errors.push({ row: rowNo, club: club.name, field: "Юрлицо", issue: "Юрлицо не привязано к клубу" });
          continue;
        }
        legalEntityId = match.id;
      }
    }

    const vendorName = String(at("vendor") ?? "").trim() || null;

    // Part 3: skip the row if an identical record already exists (or is repeated
    // earlier in this file). Does not block the rest of the file.
    const key = expenseDupKey({ companyId: club.companyId, clubId: club.id, expenseDate, amountKopeks, category, paymentMethod, vendorName, legalEntityId });
    if (dupKeys.has(key)) {
      result.duplicates.push({ row: rowNo, club: club.name, field: "Дубль", issue: DUPLICATE_ROW_ISSUE });
      continue;
    }
    dupKeys.add(key);

    // Budget-overrun gate (same as manual): waiting + approval request.
    const month = currentMonthKey(expenseDate);
    const evalBudget = await evaluateExpenseBudget(club.id, category, month, amountKopeks);
    const overBudget = evalBudget.hasLimit && evalBudget.projectedKopeks > evalBudget.limitKopeks;
    const notes = String(at("comment") ?? "").trim() || null;

    const expense = await prisma.expense.create({
      data: {
        companyId: club.companyId,
        clubId: club.id,
        createdByUserId: ctx.user.id,
        type,
        category,
        vendorName,
        amountKopeks,
        currency: "RUB",
        expenseDate,
        paymentMethod,
        notes,
        legalEntityId,
        confidence: "low",
        status: overBudget ? SOURCE_STATUS_WAITING : "confirmed",
        importBatchId: batchId,
      },
    });
    result.created++;

    await recordAudit({
      action: "expense.created",
      entityType: "Expense",
      entityId: expense.id,
      companyId: club.companyId,
      clubId: club.id,
      userId: ctx.user.id,
      metadata: { source: "excel_import", type, amountKopeks, status: expense.status },
    });

    if (overBudget) {
      budgetPending++;
      const request = await prisma.budgetApprovalRequest.create({
        data: {
          companyId: club.companyId,
          clubId: club.id,
          category,
          month,
          sourceType: "expense",
          sourceId: expense.id,
          budgetId: evalBudget.budgetId,
          requestedAmountKopeks: amountKopeks,
          budgetAmountKopeks: evalBudget.limitKopeks,
          currentSpentKopeks: evalBudget.usedKopeks,
          projectedSpentKopeks: evalBudget.projectedKopeks,
          overrunKopeks: evalBudget.overrunKopeks,
          reason: notes,
          status: "pending",
          requestedByUserId: ctx.user.id,
          currentLimitAmountKopeks: evalBudget.limitKopeks,
          overByAmountKopeks: evalBudget.overrunKopeks,
          overByPercent: evalBudget.limitKopeks > 0 ? (evalBudget.overrunKopeks / evalBudget.limitKopeks) * 100 : 0,
        },
      });
      await recordAudit({
        action: "budget_approval.created",
        entityType: "BudgetApprovalRequest",
        entityId: request.id,
        companyId: club.companyId,
        clubId: club.id,
        userId: ctx.user.id,
        metadata: { sourceType: "expense", sourceId: expense.id, category, month, overrunKopeks: evalBudget.overrunKopeks },
      });
    }
  }

  await finalizeImportBatch(
    batchId,
    { created: result.created, skipped: result.skipped, duplicated: result.duplicates.length, errored: result.errors.length },
    { processed: result.processed, budgetPending },
  );
  if (result.duplicates.length > 0) {
    await recordAudit({
      action: "import.row_duplicate_skipped",
      entityType: "ImportBatch",
      entityId: batchId,
      companyId,
      userId: ctx.user.id,
      metadata: { type: "expenses", count: result.duplicates.length, rows: result.duplicates.map((d) => d.row) },
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
      type: "expenses",
      fileName: fileEntry.name,
      fileHash,
      created: result.created,
      skipped: result.skipped,
      duplicated: result.duplicates.length,
      errored: result.errors.length,
    },
  });

  if (budgetPending > 0) {
    revalidatePath("/budgets");
    revalidatePath("/dashboard");
  }
  revalidatePath("/expenses");
  return { ok: true, result };
}
