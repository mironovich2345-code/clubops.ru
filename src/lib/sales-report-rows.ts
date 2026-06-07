// Pure, client-safe constants + validation for daily sales reports (no prisma
// imports, so client components can use them too). Server queries live in
// sales-reports.ts, which re-exports these.

export const SALES_REPORT_ROWS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "total_revenue", label: "Общая выручка" },
  { key: "revenue_ooo", label: "Выручка ООО" },
  { key: "revenue_ip", label: "Выручка ИП" },
  { key: "cash_ooo", label: "Наличные ООО" },
  { key: "cashless_ooo", label: "Безнал ООО" },
  { key: "card_ooo", label: "Безнал карты ООО" },
  { key: "sbp_ooo", label: "Безнал СБП ООО" },
  { key: "link_ooo", label: "Ссылка ООО" },
  { key: "cash_ip", label: "Наличные ИП" },
  { key: "cashless_ip", label: "Безнал ИП" },
  { key: "card_ip", label: "Безнал карты ИП" },
  { key: "sbp_ip", label: "Безнал СБП ИП" },
  { key: "subscriptions_ooo", label: "Аб-ты + доп. ООО" },
  { key: "personal_training_ooo", label: "ПТ + ГП ООО" },
  { key: "personal_training_total", label: "Общее ПТ" },
  { key: "encashment_ooo", label: "Инкассация ООО" },
  { key: "withdrawal", label: "Изъятие" },
];

export const SALES_REPORT_ROW_LABELS: Record<string, string> = Object.fromEntries(
  SALES_REPORT_ROWS.map((r) => [r.key, r.label]),
);

export const REVENUE_LINE_KEY = "total_revenue";

// Accepted upload formats (client-safe; the server validates by MIME/extension).
export const REPORT_ACCEPT_ATTR = ".jpg,.jpeg,.png,.webp,.heic,.pdf,.xls,.xlsx,.csv";

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

/**
 * Cross-foot the report. Returns human-readable mismatch warnings (empty =
 * balances). Amounts are in the same unit on both sides (rubles or kopeks).
 * Validation never blocks saving.
 */
export function validateSalesReportLines(byKey: Record<string, number>): string[] {
  const g = (k: string) => byKey[k] ?? 0;
  const warnings: string[] = [];
  const checks: Array<[number, number, string]> = [
    [g("total_revenue"), g("revenue_ooo") + g("revenue_ip"), "Общая выручка ≠ Выручка ООО + Выручка ИП"],
    [g("revenue_ooo"), g("cash_ooo") + g("cashless_ooo") + g("link_ooo"), "Выручка ООО ≠ Наличные ООО + Безнал ООО + Ссылка ООО"],
    [g("cashless_ooo"), g("card_ooo") + g("sbp_ooo"), "Безнал ООО ≠ Безнал карты ООО + Безнал СБП ООО"],
    [g("revenue_ip"), g("cash_ip") + g("cashless_ip"), "Выручка ИП ≠ Наличные ИП + Безнал ИП"],
    [g("cashless_ip"), g("card_ip") + g("sbp_ip"), "Безнал ИП ≠ Безнал карты ИП + Безнал СБП ИП"],
    [g("personal_training_total"), g("personal_training_ooo"), "Общее ПТ ≠ ПТ + ГП ООО"],
  ];
  for (const [actual, expected, msg] of checks) {
    if (Math.round(actual) !== Math.round(expected)) warnings.push(msg);
  }
  return warnings;
}

export function linesToMap(lines: Array<{ key: string; amountKopeks: number }>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of lines) m[l.key] = l.amountKopeks;
  return m;
}
