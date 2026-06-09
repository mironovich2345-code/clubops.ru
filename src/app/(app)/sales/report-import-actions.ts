"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";
import { rublesToKopeks } from "@/lib/money";
import {
  getCurrentAccessContext,
  getCurrentCompanyAndClub,
  getClubsInScope,
  recordAudit,
} from "@/lib/access";
import {
  SALES_REPORT_ROWS,
  SALES_REPORT_ROW_LABELS,
  REVENUE_LINE_KEY,
  computeSalesReportTotals,
} from "@/lib/sales-reports";
import { getClubEntityByType } from "@/lib/legal-entities";
import { isUploadedFile } from "@/lib/uploaded-file";
import {
  readSheetRows,
  resolveColumns,
  parseDateCell,
  parseAmountCell,
  matchClubByName,
  isBlankRow,
  newSummary,
  type ImportActionState,
  type ColumnSpec,
} from "@/lib/excel-import";
import { fileSha256, findDuplicateFileBatch, createImportBatch, finalizeImportBatch } from "@/lib/import-batches";

const ACTIVE_REPORT_STATUSES = ["pending_accountant", "confirmed"];

// The 11 manager-typed (base) amount inputs, in template order. Calculated rows
// (Безнал/Выручка/Общее ПТ/Общая выручка) are NEVER taken from the file.
const INPUT_COLUMNS: ColumnSpec[] = [
  { key: "cash_ooo", headers: ["Наличные ООО"], required: true },
  { key: "card_ooo", headers: ["Карты ООО", "Безнал карты ООО"], required: true },
  { key: "sbp_ooo", headers: ["СБП ООО", "Безнал СБП ООО"], required: true },
  { key: "link_ooo", headers: ["Ссылка ООО"], required: true },
  { key: "subscriptions_ooo", headers: ["Абонементы ООО", "Аб-ты + доп. ООО"], required: true },
  { key: "personal_training_ooo", headers: ["ПТ + ГП ООО", "ПТ и ГП ООО"], required: true },
  { key: "encashment_ooo", headers: ["Инкассация ООО"], required: true },
  { key: "withdrawal", headers: ["Изъятие"], required: true },
  { key: "cash_ip", headers: ["Наличные ИП"], required: true },
  { key: "card_ip", headers: ["Карты ИП", "Безнал карты ИП"], required: true },
  { key: "sbp_ip", headers: ["СБП ИП", "Безнал СБП ИП"], required: true },
];

const COLUMNS: ColumnSpec[] = [
  { key: "reportDate", headers: ["Дата отчёта", "Дата"], required: true },
  { key: "club", headers: ["Клуб"], required: true },
  { key: "managerName", headers: ["Менеджер смены", "Менеджер"] },
  ...INPUT_COLUMNS,
];

const dayKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;

/**
 * Import daily sales reports from an Excel/CSV file. One row = one report.
 * Mirrors the manual create flow: server recomputes all calculated lines, blocks
 * duplicate active reports per club+date, rejects negative amounts, maps ООО/ИП
 * legal entities, and creates reports with status pending_accountant. Valid rows
 * import even if other rows fail. Manager/regional only, scope-restricted.
 */
export async function importSalesReports(
  _prev: ImportActionState | undefined,
  formData: FormData,
): Promise<ImportActionState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) {
    return { ok: false, error: "Нет доступа" };
  }
  if (!canCreateOperational(ctx.effectiveRoles)) {
    return { ok: false, error: "Импортировать отчёты могут управляющие и региональные директора" };
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
  const prior = await findDuplicateFileBatch(companyId, "sales_reports", fileHash);
  if (prior) {
    const by = (await prisma.user.findUnique({ where: { id: prior.createdByUserId }, select: { name: true } }))?.name ?? "—";
    await recordAudit({
      action: "import.duplicate_file_blocked",
      entityType: "ImportBatch",
      companyId,
      userId: ctx.user.id,
      metadata: { type: "sales_reports", fileName: fileEntry.name, fileHash },
    });
    return {
      ok: false,
      error: "Этот файл уже загружался ранее. Повторная загрузка заблокирована.",
      blocked: { at: prior.createdAt.toISOString(), by },
    };
  }

  const scope = await getCurrentCompanyAndClub(ctx.user);
  const clubs = await getClubsInScope(scope); // scope-restricted (no cross-club / cross-company)

  const result = newSummary();
  const seen = new Set<string>(); // clubId|day within this file
  const entityCache = new Map<string, { ooo: string | null; ip: string | null }>();
  const batchId = await createImportBatch({
    companyId,
    clubId: scope.club?.id ?? null,
    type: "sales_reports",
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
    const nameCell = at("club");
    const clubLabel = String(nameCell ?? "").trim() || "—";

    const { club, ambiguous } = matchClubByName(clubs, nameCell);
    if (ambiguous) {
      result.errors.push({ row: rowNo, club: clubLabel, field: "Клуб", issue: "Несколько клубов с таким названием" });
      continue;
    }
    if (!club) {
      result.errors.push({ row: rowNo, club: clubLabel, field: "Клуб", issue: "Клуб не найден в доступной компании" });
      continue;
    }

    const reportDate = parseDateCell(at("reportDate"));
    if (!reportDate) {
      result.errors.push({ row: rowNo, club: club.name, field: "Дата отчёта", issue: "Неверный формат даты" });
      continue;
    }

    // Duplicate within the same file (existing club+date logic, kept).
    const dupKey = `${club.id}|${dayKey(reportDate)}`;
    if (seen.has(dupKey)) {
      result.duplicates.push({ row: rowNo, club: club.name, field: "Дата отчёта", issue: "Дубликат строки (клуб + дата)" });
      continue;
    }

    // Parse base amounts: empty → 0, non-numeric or negative → row error.
    const baseRub: Record<string, number> = {};
    let amountError: { field: string; issue: string } | null = null;
    for (const col of INPUT_COLUMNS) {
      const parsed = parseAmountCell(at(col.key));
      if (parsed.error) {
        amountError = { field: col.headers[0], issue: "Сумма должна быть числом" };
        break;
      }
      const v = parsed.value ?? 0;
      if (v < 0) {
        amountError = { field: col.headers[0], issue: "Сумма не может быть отрицательной" };
        break;
      }
      baseRub[col.key] = v;
    }
    if (amountError) {
      result.errors.push({ row: rowNo, club: club.name, ...amountError });
      continue;
    }

    // Existing active report for this club+date blocks the import.
    const dayStart = reportDate; // already UTC midnight
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const existing = await prisma.salesReport.findFirst({
      where: { clubId: club.id, reportDate: { gte: dayStart, lt: dayEnd }, status: { in: ACTIVE_REPORT_STATUSES } },
      select: { id: true },
    });
    if (existing) {
      result.duplicates.push({ row: rowNo, club: club.name, field: "Дата отчёта", issue: "Отчёт за эту дату уже существует" });
      continue;
    }

    // Recompute every calculated line on the server; client/file values ignored.
    const baseKopeks: Record<string, number> = {};
    for (const key of Object.keys(baseRub)) baseKopeks[key] = rublesToKopeks(baseRub[key]);
    const allKopeks = computeSalesReportTotals(baseKopeks);

    let entities = entityCache.get(club.id);
    if (!entities) {
      const [ooo, ip] = await Promise.all([getClubEntityByType(club.id, "ooo"), getClubEntityByType(club.id, "ip")]);
      entities = { ooo: ooo?.id ?? null, ip: ip?.id ?? null };
      entityCache.set(club.id, entities);
    }
    const entityForSection = (section: string): string | null =>
      section === "ooo" ? entities!.ooo : section === "ip" ? entities!.ip : null;

    const lines = SALES_REPORT_ROWS.map((r, idx) => ({
      key: r.key,
      label: SALES_REPORT_ROW_LABELS[r.key] ?? r.label,
      amountKopeks: allKopeks[r.key] ?? 0,
      sortOrder: idx,
      legalEntityId: entityForSection(r.section),
    }));

    const managerName = String(at("managerName") ?? "").trim() || null;
    const report = await prisma.salesReport.create({
      data: {
        companyId: club.companyId,
        clubId: club.id,
        reportDate,
        managerName,
        createdByUserId: ctx.user.id,
        status: "pending_accountant",
        importBatchId: batchId,
        lines: { create: lines },
      },
    });
    seen.add(dupKey);
    result.created++;

    await recordAudit({
      action: "sales_report.created",
      entityType: "SalesReport",
      entityId: report.id,
      companyId: club.companyId,
      clubId: club.id,
      userId: ctx.user.id,
      metadata: { source: "excel_import", totalRevenueKopeks: allKopeks[REVENUE_LINE_KEY] ?? 0 },
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
      metadata: { type: "sales_reports", count: result.duplicates.length, rows: result.duplicates.map((d) => d.row) },
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
      type: "sales_reports",
      fileName: fileEntry.name,
      fileHash,
      created: result.created,
      skipped: result.skipped,
      duplicated: result.duplicates.length,
      errored: result.errors.length,
    },
  });

  revalidatePath("/sales");
  revalidatePath("/dashboard");
  return { ok: true, result };
}
