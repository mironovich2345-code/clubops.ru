import { prisma } from "@/lib/prisma";
import type { Role } from "@/lib/auth";
import { csvDate, csvDateTime, csvMoney, type CsvCell } from "@/lib/csv";
import { INVOICE_STATUS_LABELS } from "@/lib/invoices";
import { APPROVAL_STATUS_LABELS } from "@/lib/approval";
import { expenseCategoryLabel, EXPENSE_TYPE_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/expenses";
import {
  SALES_REPORT_STATUS_LABELS,
  REVENUE_LINE_KEY,
  CASH_OOO_KEY,
  ENCASHMENT_KEY,
} from "@/lib/sales-report-rows";

export const EXPORT_TYPES = ["sales", "expenses", "invoices", "refunds"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export function isExportType(v: string): v is ExportType {
  return (EXPORT_TYPES as readonly string[]).includes(v);
}

export const EXPORT_LABELS: Record<ExportType, string> = {
  sales: "Сменные отчёты / продажи",
  expenses: "Расходы",
  invoices: "Счета",
  refunds: "Возвраты",
};

export const EXPORT_AUDIT: Record<ExportType, string> = {
  sales: "export.sales",
  expenses: "export.expenses",
  invoices: "export.invoices",
  refunds: "export.refunds",
};

// Per-role export rights (mirrors the task matrix). Marketer may export sales
// only; everyone else (owner/GD/RD/manager/accountant) may export the
// operational sections. Scope (allowed clubs) is enforced separately.
const EXPORT_ROLES: Record<ExportType, readonly Role[]> = {
  sales: ["owner", "general_director", "regional_director", "manager", "accountant", "marketer"],
  expenses: ["owner", "general_director", "regional_director", "manager", "accountant"],
  invoices: ["owner", "general_director", "regional_director", "manager", "accountant"],
  refunds: ["owner", "general_director", "regional_director", "manager", "accountant"],
};

export function canExport(roles: readonly Role[], type: ExportType): boolean {
  return roles.some((r) => EXPORT_ROLES[type].includes(r));
}

export function allowedExportTypes(roles: readonly Role[]): ExportType[] {
  return EXPORT_TYPES.filter((t) => canExport(roles, t));
}

const EXPENSE_STATUS_LABELS: Record<string, string> = {
  confirmed: "Подтверждён",
  waiting_budget_approval: "Ожидает согласования бюджета",
  budget_rejected: "Отклонён (бюджет)",
  canceled: "Отменён",
  import_reverted: "Импорт отменён",
};

export type ExportResult = { headers: string[]; rows: CsvCell[][] };
export type ExportOpts = { status?: string; category?: string };

export function exportFilename(type: ExportType, start: Date, end: Date): string {
  const d = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const lastDay = new Date(end.getTime() - 86_400_000);
  return `clubops-${type}-${d(start)}_${d(lastDay)}.csv`;
}

// --- builders --------------------------------------------------------------

export async function buildSalesExport(companyId: string, clubIds: string[], start: Date, end: Date, opts: ExportOpts): Promise<ExportResult> {
  const reports = await prisma.salesReport.findMany({
    where: { companyId, clubId: { in: clubIds }, reportDate: { gte: start, lt: end }, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ reportDate: "desc" }, { createdAt: "desc" }],
    include: { club: { select: { name: true } }, createdBy: { select: { name: true } }, lines: { select: { key: true, amountKopeks: true } } },
  });
  const verifierIds = [...new Set(reports.map((r) => r.verifiedByUserId).filter((x): x is string => !!x))];
  const verifiers = verifierIds.length ? await prisma.user.findMany({ where: { id: { in: verifierIds } }, select: { id: true, name: true } }) : [];
  const nameOf = (id: string | null) => (id ? verifiers.find((v) => v.id === id)?.name ?? "" : "");

  const headers = [
    "Дата отчёта", "Клуб", "Статус", "Менеджер смены",
    "Общая выручка", "Выручка ООО", "Наличные ООО", "Безнал ООО", "Карты ООО", "СБП ООО", "Ссылка ООО",
    "Выручка ИП", "Наличные ИП", "Безнал ИП", "Карты ИП", "СБП ИП",
    "Инкассация ООО", "Остаток наличности ООО",
    "Проверил бухгалтер", "Дата проверки", "Комментарий бухгалтера",
  ];
  const rows: CsvCell[][] = reports.map((r) => {
    const m = new Map(r.lines.map((l) => [l.key, l.amountKopeks]));
    const g = (k: string) => m.get(k) ?? 0;
    return [
      csvDate(r.reportDate), r.club.name, SALES_REPORT_STATUS_LABELS[r.status] ?? r.status, r.managerName ?? r.createdBy.name,
      csvMoney(g(REVENUE_LINE_KEY)), csvMoney(g("revenue_ooo")), csvMoney(g(CASH_OOO_KEY)), csvMoney(g("cashless_ooo")), csvMoney(g("card_ooo")), csvMoney(g("sbp_ooo")), csvMoney(g("link_ooo")),
      csvMoney(g("revenue_ip")), csvMoney(g("cash_ip")), csvMoney(g("cashless_ip")), csvMoney(g("card_ip")), csvMoney(g("sbp_ip")),
      csvMoney(g(ENCASHMENT_KEY)), csvMoney(g(CASH_OOO_KEY) - g(ENCASHMENT_KEY)),
      nameOf(r.verifiedByUserId), csvDateTime(r.verifiedAt), r.accountantComment ?? "",
    ];
  });
  return { headers, rows };
}

export async function buildExpensesExport(companyId: string, clubIds: string[], start: Date, end: Date, opts: ExportOpts): Promise<ExportResult> {
  const expenses = await prisma.expense.findMany({
    where: {
      companyId,
      clubId: { in: clubIds },
      expenseDate: { gte: start, lt: end },
      // Default export excludes canceled / reverted rows; an explicit status
      // filter (e.g. status=canceled) can still include them.
      ...(opts.status ? { status: opts.status } : { status: { notIn: ["canceled", "import_reverted"] } }),
      ...(opts.category ? { category: opts.category } : {}),
    },
    orderBy: { expenseDate: "desc" },
    include: { club: { select: { name: true } }, createdBy: { select: { name: true } }, legalEntity: { select: { name: true } } },
  });
  const headers = ["Дата", "Клуб", "Статус", "Статья", "Тип", "Способ оплаты", "Юрлицо", "Контрагент / магазин / получатель", "Сумма", "Комментарий", "Кто создал"];
  const rows: CsvCell[][] = expenses.map((e) => [
    csvDate(e.expenseDate), e.club.name, EXPENSE_STATUS_LABELS[e.status] ?? e.status,
    expenseCategoryLabel(e.category), EXPENSE_TYPE_LABELS[e.type] ?? e.type,
    e.paymentMethod ? PAYMENT_METHOD_LABELS[e.paymentMethod] ?? e.paymentMethod : "",
    e.legalEntity?.name ?? "", e.vendorName ?? e.recipientName ?? "", csvMoney(e.amountKopeks),
    e.comment ?? e.notes ?? e.transferComment ?? "", e.createdBy.name,
  ]);
  return { headers, rows };
}

export async function buildInvoicesExport(companyId: string, clubIds: string[], start: Date, end: Date, opts: ExportOpts): Promise<ExportResult> {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      clubId: { in: clubIds },
      OR: [{ invoiceDate: { gte: start, lt: end } }, { invoiceDate: null, createdAt: { gte: start, lt: end } }],
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { club: { select: { name: true } }, createdBy: { select: { name: true } }, legalEntity: { select: { name: true } } },
  });
  const headers = ["Дата счёта", "Клуб", "Статус", "Юрлицо", "Поставщик", "Плательщик", "Номер счёта", "Сумма", "Статья расходов", "Срок оплаты", "Дата оплаты", "Кто создал"];
  const rows: CsvCell[][] = invoices.map((i) => [
    csvDate(i.invoiceDate ?? i.createdAt), i.club.name, INVOICE_STATUS_LABELS[i.status] ?? i.status,
    i.legalEntity?.name ?? "", i.counterpartyName ?? "", i.payerName ?? "", i.invoiceNumber ?? "",
    csvMoney(i.amountKopeks), i.expenseCategory ? expenseCategoryLabel(i.expenseCategory) : "",
    csvDate(i.dueDate), csvDateTime(i.paidAt), i.createdBy.name,
  ]);
  return { headers, rows };
}

export async function buildRefundsExport(companyId: string, clubIds: string[], start: Date, end: Date, opts: ExportOpts): Promise<ExportResult> {
  const refunds = await prisma.refund.findMany({
    where: {
      companyId,
      clubId: { in: clubIds },
      OR: [{ refundDate: { gte: start, lt: end } }, { refundDate: null, createdAt: { gte: start, lt: end } }],
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { club: { select: { name: true } }, createdBy: { select: { name: true } } },
  });
  const headers = ["Дата возврата", "Клуб", "Статус", "Клиент", "Телефон", "Сумма", "Причина", "Проверил / согласовал", "Дата оплаты"];
  const rows: CsvCell[][] = refunds.map((r) => [
    csvDate(r.refundDate ?? r.createdAt), r.club.name, APPROVAL_STATUS_LABELS[r.status] ?? r.status,
    r.clientName ?? "", r.clientPhone ?? "", csvMoney(r.amountKopeks), r.reason ?? "",
    "", csvDateTime(r.paidAt),
  ]);
  return { headers, rows };
}

export async function buildExport(type: ExportType, companyId: string, clubIds: string[], start: Date, end: Date, opts: ExportOpts): Promise<ExportResult> {
  if (clubIds.length === 0) {
    const empty: Record<ExportType, string[]> = {
      sales: ["Дата отчёта"], expenses: ["Дата"], invoices: ["Дата счёта"], refunds: ["Дата возврата"],
    };
    return { headers: empty[type], rows: [] };
  }
  switch (type) {
    case "sales": return buildSalesExport(companyId, clubIds, start, end, opts);
    case "expenses": return buildExpensesExport(companyId, clubIds, start, end, opts);
    case "invoices": return buildInvoicesExport(companyId, clubIds, start, end, opts);
    case "refunds": return buildRefundsExport(companyId, clubIds, start, end, opts);
  }
}
