// Sales-plan XLSX import: template generation, sheet parsing, and a PURE preview
// builder (owner/GD only, enforced in the server action). The plan total is never
// entered by the user — it is membershipPlan + personalTrainingPlan. Scope is
// enforced by matching clubId against the caller's allowed clubs. No secrets/PII.
import * as XLSX from "xlsx";
import { readSheetRows, resolveColumns, norm, isBlankRow, type ColumnSpec } from "@/lib/excel-import";
import { parseImportAmountToKopeks } from "@/lib/imports/amount";

export type PlanScopeClub = { id: string; name: string; city: string };
export type CurrentPlan = { clubId: string; subsKopeks: number; ptKopeks: number };

export type PlanPreviewRow = {
  rowNum: number;
  clubId: string | null;
  clubName: string;
  currentSubsKopeks: number;
  newSubsKopeks: number;
  currentPtKopeks: number;
  newPtKopeks: number;
  currentTotalKopeks: number;
  newTotalKopeks: number;
  status: "create" | "update" | "error";
  error?: string;
};

export type RawPlanRow = { rowNum: number; clubIdCell: unknown; clubNameCell: unknown; monthCell: unknown; subsCell: unknown; ptCell: unknown };

// Template + parse column spec. clubId is an explicit column so clubs with the same
// name never collide.
const PLAN_COLUMNS: ColumnSpec[] = [
  { key: "clubId", headers: ["clubId", "ID клуба"], required: true },
  { key: "clubName", headers: ["Клуб", "clubName"] },
  { key: "city", headers: ["Город", "cityName"] },
  { key: "month", headers: ["Месяц", "planMonth", "month"] },
  { key: "subs", headers: ["План АБ", "membershipPlan", "Абонементы"], required: true },
  { key: "pt", headers: ["План ПТ", "personalTrainingPlan", "Персональные тренировки"], required: true },
];

export const PLAN_TEMPLATE_HEADER = ["clubId", "Клуб", "Город", "Месяц", "План АБ", "План ПТ"];

/** Build the XLSX plan template for a month + the scope's clubs. Returns a Buffer. */
export function buildPlanTemplateBuffer(month: string, clubs: PlanScopeClub[]): Buffer {
  const rows = clubs.map((c) => [c.id, c.name, c.city, month, "", ""]);
  const ws = XLSX.utils.aoa_to_sheet([PLAN_TEMPLATE_HEADER, ...rows]);
  ws["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 16 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Планы");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Parse an uploaded plan sheet into raw rows (no validation yet). */
export function parsePlanSheet(buffer: Buffer): { rows: RawPlanRow[]; missing: string[] } {
  const aoa = readSheetRows(buffer);
  if (aoa.length === 0) return { rows: [], missing: PLAN_COLUMNS.filter((c) => c.required).map((c) => c.headers[0]) };
  const { index, missing } = resolveColumns(aoa[0], PLAN_COLUMNS);
  if (missing.length) return { rows: [], missing };
  const rows: RawPlanRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (isBlankRow(r)) continue;
    rows.push({
      rowNum: i + 1,
      clubIdCell: r[index.clubId],
      clubNameCell: index.clubName != null ? r[index.clubName] : "",
      monthCell: index.month != null ? r[index.month] : "",
      subsCell: r[index.subs],
      ptCell: r[index.pt],
    });
  }
  return { rows, missing: [] };
}

function amount(cell: unknown): { kopeks: number } | { error: string } {
  const p = parseImportAmountToKopeks(cell);
  if ("empty" in p) return { kopeks: 0 };
  if ("error" in p) return { error: "Неверная сумма" };
  return { kopeks: p.kopeks };
}

/** PURE: build the preview (create/update/error per row). Enforces scope: a clubId
 * outside `scopeClubs` is an error row. `month` is the authoritative selected month. */
export function buildPlanPreview(input: { rawRows: RawPlanRow[]; scopeClubs: PlanScopeClub[]; currentPlans: CurrentPlan[]; month: string }): { rows: PlanPreviewRow[]; anyError: boolean } {
  const byId = new Map(input.scopeClubs.map((c) => [c.id, c]));
  const byName = new Map<string, PlanScopeClub[]>();
  for (const c of input.scopeClubs) {
    const k = norm(c.name);
    byName.set(k, [...(byName.get(k) ?? []), c]);
  }
  const curById = new Map(input.currentPlans.map((p) => [p.clubId, p]));
  const rows: PlanPreviewRow[] = [];
  let anyError = false;
  const seen = new Set<string>();

  for (const raw of input.rawRows) {
    const idCell = String(raw.clubIdCell ?? "").trim();
    let club = idCell ? byId.get(idCell) : undefined;
    if (!club) {
      const hits = byName.get(norm(raw.clubNameCell));
      if (hits && hits.length === 1) club = hits[0];
    }
    const nameShown = club?.name ?? String(raw.clubNameCell ?? idCell ?? "—");
    const mkErr = (error: string): PlanPreviewRow => ({ rowNum: raw.rowNum, clubId: club?.id ?? null, clubName: nameShown, currentSubsKopeks: 0, newSubsKopeks: 0, currentPtKopeks: 0, newPtKopeks: 0, currentTotalKopeks: 0, newTotalKopeks: 0, status: "error", error });

    if (!club) { anyError = true; rows.push(mkErr("Клуб не найден в доступных клубах")); continue; }
    if (seen.has(club.id)) { anyError = true; rows.push(mkErr("Дублирующая строка по этому клубу")); continue; }
    const monthCell = String(raw.monthCell ?? "").trim();
    if (monthCell && monthCell !== input.month) { anyError = true; rows.push(mkErr(`Месяц в строке (${monthCell}) не совпадает с выбранным (${input.month})`)); continue; }
    const s = amount(raw.subsCell);
    const p = amount(raw.ptCell);
    if ("error" in s) { anyError = true; rows.push(mkErr("План АБ: неверная сумма")); continue; }
    if ("error" in p) { anyError = true; rows.push(mkErr("План ПТ: неверная сумма")); continue; }
    seen.add(club.id);
    const cur = curById.get(club.id);
    const currentSubs = cur?.subsKopeks ?? 0;
    const currentPt = cur?.ptKopeks ?? 0;
    rows.push({
      rowNum: raw.rowNum,
      clubId: club.id,
      clubName: club.name,
      currentSubsKopeks: currentSubs,
      newSubsKopeks: s.kopeks,
      currentPtKopeks: currentPt,
      newPtKopeks: p.kopeks,
      currentTotalKopeks: currentSubs + currentPt,
      newTotalKopeks: s.kopeks + p.kopeks, // total is ALWAYS АБ + ПТ, never user-entered
      status: cur ? "update" : "create",
    });
  }
  return { rows, anyError };
}
