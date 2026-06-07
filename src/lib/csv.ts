// Minimal RFC-4180 CSV writer. UTF-8 BOM so Excel reads Cyrillic; CRLF line
// endings; fields quoted only when they contain a comma, quote or newline.

const BOM = "﻿";

function escapeCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type CsvCell = string | number | null | undefined;

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const line = (cells: CsvCell[]) => cells.map((c) => escapeCell(c == null ? "" : String(c))).join(",");
  return BOM + [line(headers), ...rows.map(line)].join("\r\n") + "\r\n";
}

// Date-only fields are stored as UTC midnight (parsed from "YYYY-MM-DD"); format
// in UTC to avoid a day shift. Timestamps (verifiedAt, paidAt) use local time.
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function csvDate(d: Date | null | undefined): string {
  return d ? dateFmt.format(d) : "";
}
export function csvDateTime(d: Date | null | undefined): string {
  return d ? dateTimeFmt.format(d) : "";
}
/** Kopeks -> plain numeric rubles "1250.00" (machine-parseable). */
export function csvMoney(kopeks: number | null | undefined): string {
  return ((kopeks ?? 0) / 100).toFixed(2);
}
