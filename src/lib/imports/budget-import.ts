// Budget-by-category XLSX import: template generation, sheet parsing, and a PURE
// preview builder (owner/GD only, enforced in the server action). Budget lines reuse
// the existing expense/budget categories; a club's monthly budget = sum of its
// category rows (no separate total field). Scope enforced by clubId match. No PII.
import * as XLSX from "xlsx";
import { readSheetRows, resolveColumns, norm, isBlankRow, type ColumnSpec } from "@/lib/excel-import";
import { parseImportAmountToKopeks } from "@/lib/imports/amount";

export type BudgetScopeClub = { id: string; name: string; city: string };
export type BudgetCategory = { key: string; label: string };
export type CurrentBudget = { clubId: string; category: string; limitKopeks: number };

export type BudgetPreviewRow = {
  rowNum: number;
  clubId: string | null;
  clubName: string;
  category: string | null;
  categoryLabel: string;
  currentKopeks: number;
  newKopeks: number;
  deltaKopeks: number;
  status: "create" | "update" | "error";
  error?: string;
};

export type RawBudgetRow = { rowNum: number; clubIdCell: unknown; clubNameCell: unknown; monthCell: unknown; categoryCell: unknown; amountCell: unknown };

const BUDGET_COLUMNS: ColumnSpec[] = [
  { key: "clubId", headers: ["clubId", "ID клуба"], required: true },
  { key: "clubName", headers: ["Клуб", "clubName"] },
  { key: "city", headers: ["Город", "cityName"] },
  { key: "month", headers: ["Месяц", "budgetMonth", "month"] },
  { key: "category", headers: ["Статья бюджета", "Статья", "category"], required: true },
  { key: "amount", headers: ["Сумма", "amount"], required: true },
];

export const BUDGET_TEMPLATE_HEADER = ["clubId", "Клуб", "Город", "Месяц", "Статья бюджета", "Сумма"];

/** Build the budget template: a row per (club × category) for the month. */
export function buildBudgetTemplateBuffer(month: string, clubs: BudgetScopeClub[], categories: BudgetCategory[]): Buffer {
  const rows: (string | number)[][] = [];
  for (const c of clubs) for (const cat of categories) rows.push([c.id, c.name, c.city, month, cat.label, ""]);
  const ws = XLSX.utils.aoa_to_sheet([BUDGET_TEMPLATE_HEADER, ...rows]);
  ws["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 26 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Бюджеты");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function parseBudgetSheet(buffer: Buffer): { rows: RawBudgetRow[]; missing: string[] } {
  const aoa = readSheetRows(buffer);
  if (aoa.length === 0) return { rows: [], missing: BUDGET_COLUMNS.filter((c) => c.required).map((c) => c.headers[0]) };
  const { index, missing } = resolveColumns(aoa[0], BUDGET_COLUMNS);
  if (missing.length) return { rows: [], missing };
  const rows: RawBudgetRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (isBlankRow(r)) continue;
    rows.push({
      rowNum: i + 1,
      clubIdCell: r[index.clubId],
      clubNameCell: index.clubName != null ? r[index.clubName] : "",
      monthCell: index.month != null ? r[index.month] : "",
      categoryCell: r[index.category],
      amountCell: r[index.amount],
    });
  }
  return { rows, missing: [] };
}

/** PURE preview. Scope enforced (clubId must be in scopeClubs); category must be a
 * known budget category (match by key or label). Empty amount rows are SKIPPED (not
 * shown / not applied) so a mostly-empty template does not create thousands of zeros. */
export function buildBudgetPreview(input: { rawRows: RawBudgetRow[]; scopeClubs: BudgetScopeClub[]; categories: BudgetCategory[]; currentBudgets: CurrentBudget[]; month: string }): { rows: BudgetPreviewRow[]; anyError: boolean } {
  const byId = new Map(input.scopeClubs.map((c) => [c.id, c]));
  const byName = new Map<string, BudgetScopeClub[]>();
  for (const c of input.scopeClubs) {
    const k = norm(c.name);
    byName.set(k, [...(byName.get(k) ?? []), c]);
  }
  const catByKey = new Map(input.categories.map((c) => [c.key, c]));
  const catByLabel = new Map(input.categories.map((c) => [norm(c.label), c]));
  const curByKey = new Map(input.currentBudgets.map((b) => [`${b.clubId}::${b.category}`, b.limitKopeks]));
  const rows: BudgetPreviewRow[] = [];
  let anyError = false;
  const seen = new Set<string>();

  for (const raw of input.rawRows) {
    // Empty amount → skip this line entirely (leave existing budget unchanged).
    const amtParse = parseImportAmountToKopeks(raw.amountCell);
    if ("empty" in amtParse) continue;

    const idCell = String(raw.clubIdCell ?? "").trim();
    let club = idCell ? byId.get(idCell) : undefined;
    if (!club) {
      const hits = byName.get(norm(raw.clubNameCell));
      if (hits && hits.length === 1) club = hits[0];
    }
    const cat = catByKey.get(String(raw.categoryCell ?? "").trim()) ?? catByLabel.get(norm(raw.categoryCell));
    const nameShown = club?.name ?? String(raw.clubNameCell ?? idCell ?? "—");
    const catShown = cat?.label ?? String(raw.categoryCell ?? "—");
    const mkErr = (error: string): BudgetPreviewRow => ({ rowNum: raw.rowNum, clubId: club?.id ?? null, clubName: nameShown, category: cat?.key ?? null, categoryLabel: catShown, currentKopeks: 0, newKopeks: 0, deltaKopeks: 0, status: "error", error });

    if (!club) { anyError = true; rows.push(mkErr("Клуб не найден в доступных клубах")); continue; }
    if (!cat) { anyError = true; rows.push(mkErr("Неизвестная статья бюджета")); continue; }
    const key = `${club.id}::${cat.key}`;
    if (seen.has(key)) { anyError = true; rows.push(mkErr("Дублирующая строка по клубу и статье")); continue; }
    const monthCell = String(raw.monthCell ?? "").trim();
    if (monthCell && monthCell !== input.month) { anyError = true; rows.push(mkErr(`Месяц (${monthCell}) не совпадает с выбранным (${input.month})`)); continue; }
    if ("error" in amtParse) { anyError = true; rows.push(mkErr("Неверная сумма")); continue; }
    seen.add(key);
    const current = curByKey.get(key) ?? 0;
    rows.push({
      rowNum: raw.rowNum,
      clubId: club.id,
      clubName: club.name,
      category: cat.key,
      categoryLabel: cat.label,
      currentKopeks: current,
      newKopeks: amtParse.kopeks,
      deltaKopeks: amtParse.kopeks - current,
      status: current > 0 ? "update" : "create",
    });
  }
  return { rows, anyError };
}
