// Shared, dependency-light helpers for the Excel template/import features
// (sales reports, expenses, invoices). Mirrors the proven sales-plan import
// parsing. Pure module — safe to import *types* from client components; the
// runtime helpers (which pull in xlsx) are only used by server actions.
import * as XLSX from "xlsx";

// Error/result shapes shared by every import. `field` names the offending
// column for the on-screen errors table (row / club / field / issue).
export type ImportRowError = { row: number; club: string; field?: string; issue: string };
export type ImportSummary = {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
  // Rows skipped because an identical record already exists (Part 3). Shown in
  // the same on-screen table as errors, with row numbers.
  duplicates: ImportRowError[];
};
// `blocked` is set when an identical file was already imported (Part 2).
export type ImportActionState = {
  ok: boolean;
  error?: string;
  result?: ImportSummary;
  blocked?: { at: string; by: string };
};

export const newSummary = (): ImportSummary => ({ processed: 0, created: 0, updated: 0, skipped: 0, errors: [], duplicates: [] });

/** Standard duplicate-row warning text shown to the user. */
export const DUPLICATE_ROW_ISSUE = "Похоже, такая запись уже существует";

/** Normalize a cell/header for matching: trim, lowercase, ё→е, collapse spaces. */
export const norm = (v: unknown) =>
  String(v ?? "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

// Hard bounds around the xlsx parser (defence against prototype-pollution / ReDoS /
// decompression-bomb inputs — see docs/audits security review of `xlsx` 0.18.5).
// A file exceeding any bound is rejected with a controlled, stack-trace-free error.
export const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_WORKBOOK_SHEETS = 8;
export const MAX_WORKBOOK_ROWS = 5000;
export const MAX_WORKBOOK_COLS = 64;

/** Thrown when an uploaded workbook is too large/complex or cannot be parsed.
 * The message is user-safe (no stack trace, no library internals). */
export class WorkbookLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookLimitError";
  }
}

/**
 * Read the first worksheet as an array-of-arrays (header row included), bounded.
 * Handles .xlsx/.xls (ZIP archives, magic "PK") and .csv (UTF-8 text). Throws a
 * WorkbookLimitError on an oversized/too-complex/malformed file — never a raw
 * parser error/stack trace.
 */
export function readSheetRows(buffer: Buffer): unknown[][] {
  if (buffer.length > MAX_WORKBOOK_BYTES) {
    throw new WorkbookLimitError("Файл слишком большой для импорта (максимум 5 МБ).");
  }
  const isZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  let wb: XLSX.WorkBook;
  try {
    wb = isZip
      ? XLSX.read(buffer, { type: "buffer", cellDates: true, sheetRows: MAX_WORKBOOK_ROWS + 1 })
      : XLSX.read(buffer.toString("utf8"), { type: "string", cellDates: true, sheetRows: MAX_WORKBOOK_ROWS + 1 });
  } catch {
    throw new WorkbookLimitError("Не удалось прочитать файл. Проверьте формат (XLSX или CSV).");
  }
  if (wb.SheetNames.length > MAX_WORKBOOK_SHEETS) {
    throw new WorkbookLimitError("В файле слишком много листов.");
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  // Bound the declared range BEFORE materializing rows (guards a huge !ref).
  const ref = ws["!ref"];
  if (ref) {
    try {
      const range = XLSX.utils.decode_range(ref);
      const rows = range.e.r - range.s.r + 1;
      const cols = range.e.c - range.s.c + 1;
      if (rows > MAX_WORKBOOK_ROWS) throw new WorkbookLimitError("В файле слишком много строк (максимум 5000).");
      if (cols > MAX_WORKBOOK_COLS) throw new WorkbookLimitError("В файле слишком много колонок.");
    } catch (e) {
      if (e instanceof WorkbookLimitError) throw e;
      throw new WorkbookLimitError("Не удалось прочитать структуру файла.");
    }
  }
  const out = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
  return out.slice(0, MAX_WORKBOOK_ROWS);
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * Parse a date cell (Date | Excel serial | "DD.MM.YYYY" | "YYYY-MM-DD") into a
 * UTC-midnight Date (timezone-independent calendar day), or null. UTC midnight
 * matches how the manual sales-report form stores `reportDate`.
 */
export function parseDateCell(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const utc = new Date(EXCEL_EPOCH + Math.round(value) * 86_400_000);
    if (Number.isNaN(utc.getTime())) return null;
    return new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()));
  }
  const s = String(value).trim();
  const dmy = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    const t = Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1]));
    return Number.isNaN(t) ? null : new Date(t);
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

/** {empty} | {value:rubles} | {error}. Caller decides on negativity. */
export function parseAmountCell(cell: unknown): { empty?: true; value?: number; error?: true } {
  if (cell == null || String(cell).trim() === "") return { empty: true };
  if (typeof cell === "number") return Number.isFinite(cell) ? { value: cell } : { error: true };
  const cleaned = String(cell).trim().replace(/₽|руб\.?/gi, "").replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") return { empty: true };
  const n = Number(cleaned);
  return Number.isFinite(n) ? { value: n } : { error: true };
}

export type ColumnSpec = { key: string; headers: string[]; required?: boolean };

/**
 * Map a header row to column indices by normalized header match (exact first,
 * then startsWith). Returns the index map and any required-but-missing keys.
 */
export function resolveColumns(
  headerRow: unknown[],
  spec: ColumnSpec[],
): { index: Record<string, number>; missing: string[] } {
  const normCells = headerRow.map((c) => norm(c));
  const index: Record<string, number> = {};
  const missing: string[] = [];
  for (const col of spec) {
    let found = -1;
    for (const h of col.headers) {
      const nh = norm(h);
      let i = normCells.indexOf(nh);
      if (i === -1) i = normCells.findIndex((c) => c !== "" && c.startsWith(nh));
      if (i !== -1) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      if (col.required) missing.push(col.headers[0]);
    } else {
      index[col.key] = found;
    }
  }
  return { index, missing };
}

/** Match a club by normalized name within a scope-restricted list. */
export function matchClubByName<T extends { id: string; name: string }>(
  clubs: T[],
  nameCell: unknown,
): { club?: T; ambiguous?: boolean } {
  const n = norm(nameCell);
  if (!n) return {};
  const hits = clubs.filter((c) => norm(c.name) === n);
  if (hits.length === 1) return { club: hits[0] };
  if (hits.length > 1) return { ambiguous: true };
  return {};
}

/** True when a whole row is blank (every cell null/empty). */
export function isBlankRow(row: unknown[]): boolean {
  return row.every((c) => c == null || String(c).trim() === "");
}
