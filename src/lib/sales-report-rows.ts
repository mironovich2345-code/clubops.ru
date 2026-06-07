// Pure, client-safe model for daily sales reports (no prisma imports, so client
// components can use it too). Server queries live in sales-reports.ts, which
// re-exports these.
//
// Rows are either BASE (the manager types them) or CALCULATED (derived, read-only
// — never trusted from the client; the server always recomputes them).

export type ReportSection = "ooo" | "ip" | "totals";

export type ReportRow = {
  key: string;
  label: string;
  section: ReportSection;
  /** true => derived from base rows; read-only in the UI, recomputed on save. */
  calc: boolean;
};

export const SALES_REPORT_ROWS: ReadonlyArray<ReportRow> = [
  // ООО
  { key: "cash_ooo", label: "Наличные ООО", section: "ooo", calc: false },
  { key: "card_ooo", label: "Безнал карты ООО", section: "ooo", calc: false },
  { key: "sbp_ooo", label: "Безнал СБП ООО", section: "ooo", calc: false },
  { key: "cashless_ooo", label: "Безнал ООО", section: "ooo", calc: true },
  { key: "link_ooo", label: "Ссылка ООО", section: "ooo", calc: false },
  { key: "revenue_ooo", label: "Выручка ООО", section: "ooo", calc: true },
  { key: "subscriptions_ooo", label: "Аб-ты + доп. ООО", section: "ooo", calc: false },
  { key: "personal_training_ooo", label: "ПТ + ГП ООО", section: "ooo", calc: false },
  { key: "encashment_ooo", label: "Инкассация ООО", section: "ooo", calc: false },
  { key: "withdrawal", label: "Изъятие", section: "ooo", calc: false },
  // ИП
  { key: "cash_ip", label: "Наличные ИП", section: "ip", calc: false },
  { key: "card_ip", label: "Безнал карты ИП", section: "ip", calc: false },
  { key: "sbp_ip", label: "Безнал СБП ИП", section: "ip", calc: false },
  { key: "cashless_ip", label: "Безнал ИП", section: "ip", calc: true },
  { key: "revenue_ip", label: "Выручка ИП", section: "ip", calc: true },
  // Итоги
  { key: "personal_training_total", label: "Общее ПТ", section: "totals", calc: true },
  { key: "total_revenue", label: "Общая выручка", section: "totals", calc: true },
];

export const SALES_REPORT_ROW_LABELS: Record<string, string> = Object.fromEntries(
  SALES_REPORT_ROWS.map((r) => [r.key, r.label]),
);

/** Rows the manager edits (everything not derived). */
export const BASE_ROWS: ReadonlyArray<ReportRow> = SALES_REPORT_ROWS.filter((r) => !r.calc);
/** Derived rows — read-only; the server recomputes them and ignores client values. */
export const CALCULATED_KEYS: ReadonlyArray<string> = SALES_REPORT_ROWS.filter((r) => r.calc).map((r) => r.key);

export const REPORT_SECTIONS: ReadonlyArray<{ key: ReportSection; label: string }> = [
  { key: "ooo", label: "ООО" },
  { key: "ip", label: "ИП" },
  { key: "totals", label: "Итоги" },
];

export const CALC_HINT = "рассчитывается автоматически";

export const REVENUE_LINE_KEY = "total_revenue";
export const ENCASHMENT_KEY = "encashment_ooo";

// Accepted upload formats (client-safe; the server validates by MIME/extension).
export const REPORT_ACCEPT_ATTR = ".jpg,.jpeg,.png,.webp,.heic,.pdf,.xls,.xlsx,.csv";

/**
 * Derive all calculated rows from the base amounts. Unit-agnostic (works in
 * rubles for the live form or kopeks on the server) — it only adds. Returns a
 * full {key: amount} map (base passthrough + recomputed calculated rows); any
 * calculated value present in `values` is overwritten.
 */
export function computeSalesReportTotals(values: Record<string, number>): Record<string, number> {
  const v = (k: string) => values[k] ?? 0;
  const cashless_ooo = v("card_ooo") + v("sbp_ooo");
  const revenue_ooo = v("cash_ooo") + cashless_ooo + v("link_ooo");
  const cashless_ip = v("card_ip") + v("sbp_ip");
  const revenue_ip = v("cash_ip") + cashless_ip;
  const personal_training_total = v("personal_training_ooo");
  const total_revenue = revenue_ooo + revenue_ip;
  return {
    ...values,
    cashless_ooo,
    revenue_ooo,
    cashless_ip,
    revenue_ip,
    personal_training_total,
    total_revenue,
  };
}

// --- status / workflow -----------------------------------------------------

export type SalesReportStatus = "pending_accountant" | "confirmed" | "rejected" | "canceled";

export const SALES_REPORT_STATUS_LABELS: Record<string, string> = {
  pending_accountant: "На проверке",
  confirmed: "Подтверждён",
  rejected: "Отклонён",
  canceled: "Отменён",
};

export const SALES_REPORT_STATUS_TONE: Record<string, string> = {
  pending_accountant: "bg-amber-50 text-amber-800 ring-amber-200",
  confirmed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rejected: "bg-rose-50 text-rose-700 ring-rose-200",
  canceled: "bg-slate-100 text-slate-600 ring-slate-200",
};

export type SalesReportAction = "confirm" | "reject" | "cancel";

export const SALES_REPORT_ACTION_LABELS: Record<SalesReportAction, string> = {
  confirm: "Подтвердить",
  reject: "Отклонить",
  cancel: "Отменить",
};

export const SALES_REPORT_ACTION_AUDIT: Record<SalesReportAction, string> = {
  confirm: "sales_report.confirmed",
  reject: "sales_report.rejected",
  cancel: "sales_report.canceled",
};

export const SALES_REPORT_DESTRUCTIVE_ACTIONS: SalesReportAction[] = ["reject", "cancel"];

export function isConfirmedReport(status: string): boolean {
  return status === "confirmed";
}

/** {key: amountKopeks} from stored lines. */
export function linesToMap(lines: Array<{ key: string; amountKopeks: number }>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of lines) m[l.key] = l.amountKopeks;
  return m;
}

/**
 * Non-formula warnings (calculated totals are automatic, so no mismatch checks).
 * Currently: cash collection (инкассация) recorded but no supporting document.
 */
export function salesReportWarnings(opts: { encashmentKopeks: number; documentCount: number }): string[] {
  const warnings: string[] = [];
  if (opts.encashmentKopeks > 0 && opts.documentCount === 0) {
    warnings.push("Указана инкассация, но не приложен документ инкассации");
  }
  return warnings;
}
