import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ImportCandidate = {
  kind: "sale" | "expense";
  /** column header -> Sale.source / Expense.category */
  label: string;
  /** calendar day, ISO yyyy-mm-dd (no time component used for dedup) */
  dateISO: string;
  amountKopeks: number;
};

export type ImportPreview = {
  candidates: ImportCandidate[];
  warnings: string[];
  salesCount: number;
  expensesCount: number;
  salesTotalKopeks: number;
  expensesTotalKopeks: number;
};

// ---------------------------------------------------------------------------
// Column header dictionary (current club spreadsheet template)
// ---------------------------------------------------------------------------

// Canonical labels. Cell headers are matched by normalized prefix, so footnote
// markers ("[161]"), "из них:", "+изъятия" etc. still resolve correctly.
const SALES_HEADERS = [
  "Общая выручка",
  "Нал ООО",
  "Карты",
  "СБП",
  "БН ООО",
  "Онлайн ООО",
  "р/с",
  "Инкассация",
  "ПТ ООО",
  "Нал ИП",
  "БН ИП",
] as const;

const EXPENSE_HEADERS = [
  "Зп",
  "Тренеры ТЗ",
  "Реклама",
  "Хозрасходы",
  "Аренда",
  "Строители",
  "Вложения",
  "Возвраты",
  "Прочее",
] as const;

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\[[^\]]*\]/g, " ") // drop footnote markers like [161]
    .replace(/\s+/g, " ")
    .trim();
}

type ColumnKind = { kind: "sale" | "expense"; label: string };

function matchHeader(cell: unknown): ColumnKind | null {
  const normalized = normalizeHeader(cell);
  if (!normalized) return null;
  for (const label of SALES_HEADERS) {
    if (normalized.startsWith(normalizeHeader(label))) return { kind: "sale", label };
  }
  for (const label of EXPENSE_HEADERS) {
    if (normalized.startsWith(normalizeHeader(label))) return { kind: "expense", label };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function parseCellDate(value: unknown): Date | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Normalize to local midnight of the same calendar day (xlsx Dates are UTC).
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial date (days since 1899-12-30). Read in UTC, then rebuild at
    // local midnight so the calendar day is timezone-independent.
    const utc = new Date(EXCEL_EPOCH + Math.round(value) * 86400000);
    if (Number.isNaN(utc.getTime())) return null;
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }
  if (typeof value === "string") {
    const m = value.trim().match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      let year = Number(m[3]);
      if (year < 100) year += 2000;
      const d = new Date(year, month - 1, day);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

/** Returns the amount in rubles, or null when the cell is not a usable number. */
function parseAmountRubles(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw || /#?ref|#?value|#?n\/?a|—|-$/i.test(raw)) return null;
    const cleaned = raw
      .replace(/[\s ]/g, "")
      .replace(/₽|руб\.?/gi, "")
      .replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toISODay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function looksLikeTotalRow(cells: unknown[]): boolean {
  return cells.some((c) => /итого|всего/i.test(String(c ?? "")));
}

// ---------------------------------------------------------------------------
// Workbook parsing
// ---------------------------------------------------------------------------

function readWorkbook(buffer: Buffer): XLSX.WorkBook {
  // .xlsx is a ZIP archive (starts with "PK"); anything else is treated as text
  // (.csv) and decoded as UTF-8 so Cyrillic headers survive.
  const isZip = buffer.length > 1 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (isZip) {
    return XLSX.read(buffer, { type: "buffer", raw: true });
  }
  return XLSX.read(buffer.toString("utf8"), { type: "string", raw: true });
}

export function parseImportBuffer(buffer: Buffer): ImportPreview {
  const warnings: string[] = [];
  const candidates: ImportCandidate[] = [];

  let workbook: XLSX.WorkBook;
  try {
    workbook = readWorkbook(buffer);
  } catch {
    return emptyPreview(["Не удалось прочитать файл. Поддерживаются .xlsx и .csv."]);
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return emptyPreview(["В файле нет ни одного листа."]);

  const sheet = workbook.Sheets[sheetName];
  // raw:true keeps cells as literal strings/numbers; we parse dates and amounts
  // ourselves (SheetJS mis-detects DD.MM.YYYY dates in CSV otherwise).
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
    raw: true,
  });

  if (rows.length === 0) return emptyPreview(["Лист пустой."]);

  // Build column -> kind map by scanning the top rows (headers may span several).
  const columnKind = new Map<number, ColumnKind>();
  const headerScanLimit = Math.min(rows.length, 12);
  for (let r = 0; r < headerScanLimit; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (columnKind.has(c)) continue;
      const match = matchHeader(row[c]);
      if (match) columnKind.set(c, match);
    }
  }

  if (columnKind.size === 0) {
    return emptyPreview([
      "Не найдено ни одной известной колонки (продажи/расходы). Проверьте шаблон таблицы.",
    ]);
  }

  // Pick the date column: prefer a header cell that says "дата", otherwise the
  // column with the most date-parseable values.
  const dateColumn = detectDateColumn(rows, headerScanLimit);
  if (dateColumn === null) {
    return emptyPreview(["Не удалось определить колонку с датой."]);
  }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const date = parseCellDate(row[dateColumn]);
    if (!date) continue; // header / blank / non-data row
    if (looksLikeTotalRow(row)) continue; // ИТОГО / Всего

    const dateISO = toISODay(date);

    for (const [col, kind] of columnKind) {
      const rubles = parseAmountRubles(row[col]);
      if (rubles === null) continue; // empty / #REF! / text
      if (rubles <= 0) continue; // skip zero and negative values

      candidates.push({
        kind: kind.kind,
        label: kind.label,
        dateISO,
        amountKopeks: Math.round(rubles * 100),
      });
    }
  }

  if (candidates.length === 0) {
    warnings.push("Подходящих строк с данными не найдено.");
  }

  const sales = candidates.filter((c) => c.kind === "sale");
  const expenses = candidates.filter((c) => c.kind === "expense");

  return {
    candidates,
    warnings,
    salesCount: sales.length,
    expensesCount: expenses.length,
    salesTotalKopeks: sales.reduce((sum, c) => sum + c.amountKopeks, 0),
    expensesTotalKopeks: expenses.reduce((sum, c) => sum + c.amountKopeks, 0),
  };
}

function detectDateColumn(rows: unknown[][], headerScanLimit: number): number | null {
  // 1) explicit "ДАТА" header
  for (let r = 0; r < headerScanLimit; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (normalizeHeader(row[c]) === "дата") return c;
    }
  }
  // 2) fallback: column with the most parseable dates
  const counts = new Map<number, number>();
  for (const row of rows) {
    for (let c = 0; c < (row?.length ?? 0); c++) {
      if (parseCellDate(row[c])) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [c, count] of counts) {
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? best : null;
}

function emptyPreview(warnings: string[]): ImportPreview {
  return {
    candidates: [],
    warnings,
    salesCount: 0,
    expensesCount: 0,
    salesTotalKopeks: 0,
    expensesTotalKopeks: 0,
  };
}
