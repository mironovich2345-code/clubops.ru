// Phase 1 «Счета»: the single server-side data contract for the invoices page.
// Everything here is derived and re-checked on the server — the client cannot
// influence company/club/city/month/creator. Reporting month is COMPUTED from
// dueDate (unpaid) / paidAt (paid); nothing is persisted for it. Server-only.
import { prisma } from "@/lib/prisma";
import type { AccessContext } from "@/lib/access";
import type { Role } from "@/lib/auth";
import { canCreateOperational } from "@/lib/auth";
import {
  INVOICE_AWAITING_PAYMENT_STATUSES,
  getInvoiceReportingMonth,
  isInvoiceOverdue,
  canAddPaidInvoice,
} from "@/lib/invoices";

// Roles that get the broader (elevated) invoice view. system_admin is absent on
// purpose — it never gets financial access automatically.
const ELEVATED_ROLES: readonly Role[] = ["regional_director", "accountant", "chief_accountant", "owner", "general_director"];

export type InvoiceReportingRow = {
  id: string;
  clubId: string;
  clubName: string;
  city: string;
  counterpartyName: string | null;
  invoiceNumber: string | null;
  amountKopeks: number;
  expenseCategory: string | null;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  reportingMonth: string;
  overdue: boolean;
  createdByUserId: string;
};

export type CategoryDistributionItem = { category: string; amountKopeks: number; count: number };

export type ManagerSummary = {
  pendingPaymentAmountKopeks: number;
  overdueAmountKopeks: number;
  sentCount: number;
};
export type ElevatedSummary = ManagerSummary & {
  totalInvoiceAmountKopeks: number;
  paidAmountKopeks: number;
};

export type InvoicesView = {
  effectivePeriod: { year: number; month: number; start: string; end: string };
  roleView: "manager" | "elevated" | "none";
  canNavigateMonths: boolean;
  canFilterByCity: boolean;
  canFilterByClub: boolean;
  availableCities: string[];
  availableClubs: Array<{ id: string; name: string; city: string }>;
  selectedCity: string | null;
  selectedClub: string | null;
  summary: ManagerSummary | ElevatedSummary;
  currentPeriodInvoices: InvoiceReportingRow[];
  carriedOverdueInvoices: InvoiceReportingRow[];
  categoryDistribution: CategoryDistributionItem[];
  permissions: { canAddPaidInvoice: boolean; canUploadInvoice: boolean; canViewPastMonths: boolean };
};

export type InvoiceViewParams = { year?: string | number | null; month?: string | number | null; city?: string | null; clubId?: string | null };

function pad2(n: number): string { return String(n).padStart(2, "0"); }

export async function getInvoicesView(ctx: AccessContext, raw: InvoiceViewParams = {}, now: Date = new Date()): Promise<InvoicesView> {
  const roles = ctx.effectiveRoles;
  const isElevated = roles.some((r) => ELEVATED_ROLES.includes(r));
  const isManager = roles.includes("manager");
  const roleView: InvoicesView["roleView"] = isElevated ? "elevated" : isManager ? "manager" : "none";
  const companyId = ctx.selectedCompanyId;

  const permissions = {
    canAddPaidInvoice: canAddPaidInvoice(roles),
    canUploadInvoice: canCreateOperational(roles),
    canViewPastMonths: isElevated,
  };

  // Period: a manager is ALWAYS forced to the current calendar month (any client
  // year/month/from/to is ignored). Elevated roles may pick a valid month.
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  if (isElevated) {
    const y = Number.parseInt(String(raw.year ?? ""), 10);
    const m = Number.parseInt(String(raw.month ?? ""), 10);
    if (Number.isInteger(y) && y >= 2000 && y <= 2100 && Number.isInteger(m) && m >= 1 && m <= 12) { year = y; month = m; }
  }
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const selKey = `${year}-${pad2(month)}`;

  const base = (): InvoicesView => ({
    effectivePeriod: { year, month, start: start.toISOString(), end: end.toISOString() },
    roleView, canNavigateMonths: isElevated, canFilterByCity: isElevated, canFilterByClub: isElevated,
    availableCities: [], availableClubs: [], selectedCity: null, selectedClub: null,
    summary: roleView === "manager"
      ? { pendingPaymentAmountKopeks: 0, overdueAmountKopeks: 0, sentCount: 0 }
      : { pendingPaymentAmountKopeks: 0, overdueAmountKopeks: 0, sentCount: 0, totalInvoiceAmountKopeks: 0, paidAmountKopeks: 0 },
    currentPeriodInvoices: [], carriedOverdueInvoices: [], categoryDistribution: [], permissions,
  });

  if (!companyId || roleView === "none") return base();

  // Accessible clubs of THIS company (server-derived; never a client club id).
  const availableClubs = await prisma.club.findMany({
    where: { id: { in: ctx.allowedClubIds }, companyId },
    select: { id: true, name: true, city: true },
    orderBy: { name: "asc" },
  });
  const availableCities = Array.from(new Set(availableClubs.map((c) => c.city).filter(Boolean))).sort();

  // City / club filters — elevated only, and only within accessible clubs.
  let selectedCity: string | null = null;
  let selectedClub: string | null = null;
  let clubIds = availableClubs.map((c) => c.id);
  if (isElevated) {
    const cityRaw = String(raw.city ?? "").trim();
    if (cityRaw && availableCities.includes(cityRaw)) selectedCity = cityRaw;
    const clubRaw = String(raw.clubId ?? "").trim();
    const clubHit = clubRaw ? availableClubs.find((c) => c.id === clubRaw) : undefined;
    if (clubHit) selectedClub = clubHit.id;
    // A club must belong to the selected city; otherwise drop the incompatible club.
    if (selectedCity && selectedClub) {
      const cc = availableClubs.find((c) => c.id === selectedClub);
      if (!cc || cc.city !== selectedCity) selectedClub = null;
    }
    if (selectedClub) clubIds = [selectedClub];
    else if (selectedCity) clubIds = availableClubs.filter((c) => c.city === selectedCity).map((c) => c.id);
  }

  const view = base();
  view.availableClubs = availableClubs;
  view.availableCities = availableCities;
  view.selectedCity = selectedCity;
  view.selectedClub = selectedClub;
  if (clubIds.length === 0) return view;

  // Managers only ever see invoices they created (their own).
  const creatorFilter = roleView === "manager" ? { createdByUserId: ctx.user.id } : {};
  const LIVE = INVOICE_AWAITING_PAYMENT_STATUSES as unknown as string[];

  // Two bounded queries: paid-in-month + all open (live-unpaid) obligations in
  // scope. We never load the whole company history into memory.
  const [paidInMonth, liveUnpaid] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, clubId: { in: clubIds }, ...creatorFilter, status: "paid", paidAt: { gte: start, lt: end } },
      include: { club: { select: { id: true, name: true, city: true } } },
    }),
    prisma.invoice.findMany({
      where: { companyId, clubId: { in: clubIds }, ...creatorFilter, status: { in: LIVE } },
      include: { club: { select: { id: true, name: true, city: true } } },
    }),
  ]);

  const rowOf = (inv: (typeof paidInMonth)[number]): InvoiceReportingRow => ({
    id: inv.id, clubId: inv.clubId, clubName: inv.club.name, city: inv.club.city,
    counterpartyName: inv.counterpartyName, invoiceNumber: inv.invoiceNumber,
    amountKopeks: inv.amountKopeks, expenseCategory: inv.expenseCategory, status: inv.status,
    dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
    paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
    reportingMonth: getInvoiceReportingMonth(inv), overdue: isInvoiceOverdue(inv, now),
    createdByUserId: inv.createdByUserId,
  });

  const paidRows = paidInMonth.map(rowOf); // reporting month = paidAt month = selKey
  const unpaidRows = liveUnpaid.map(rowOf);
  const currentUnpaid = unpaidRows.filter((r) => r.reportingMonth === selKey);
  const currentPeriodInvoices = [...paidRows, ...currentUnpaid];
  // Carried debt: overdue, unpaid, dueDate strictly before the selected month —
  // so it can never also be in the current-period set (no duplicate).
  const carriedOverdueInvoices = unpaidRows.filter(
    (r) => r.overdue && r.dueDate !== null && new Date(r.dueDate).getTime() < start.getTime() && r.reportingMonth !== selKey,
  );

  const sum = (rows: InvoiceReportingRow[]) => rows.reduce((s, r) => s + r.amountKopeks, 0);
  const pendingPaymentAmountKopeks = sum(currentUnpaid.filter((r) => !r.overdue));
  const overdueAmountKopeks = sum(currentUnpaid.filter((r) => r.overdue)) + sum(carriedOverdueInvoices);

  // «Всего счетов отправлено» — distinct invoices SENT (invoice.sent_to_review)
  // in the month. For a manager, only those they sent themselves. Carried debt
  // from earlier months never inflates it.
  const sentAudits = await prisma.auditLog.findMany({
    where: {
      action: "invoice.sent_to_review", companyId, clubId: { in: clubIds },
      createdAt: { gte: start, lt: end }, ...(roleView === "manager" ? { userId: ctx.user.id } : {}),
    },
    select: { entityId: true },
    distinct: ["entityId"],
  });
  const sentCount = sentAudits.filter((a) => a.entityId).length;

  view.currentPeriodInvoices = currentPeriodInvoices;
  view.carriedOverdueInvoices = carriedOverdueInvoices;
  view.summary = roleView === "manager"
    ? { pendingPaymentAmountKopeks, overdueAmountKopeks, sentCount }
    : { pendingPaymentAmountKopeks, overdueAmountKopeks, sentCount, totalInvoiceAmountKopeks: sum(currentPeriodInvoices), paidAmountKopeks: sum(paidRows) };

  // Category distribution over the current-period set only (carried debt stays
  // in its own overdue block, never mixed into this month's distribution).
  const byCat = new Map<string, { amountKopeks: number; count: number }>();
  for (const r of currentPeriodInvoices) {
    const key = r.expenseCategory ?? "—";
    const cur = byCat.get(key) ?? { amountKopeks: 0, count: 0 };
    cur.amountKopeks += r.amountKopeks; cur.count += 1;
    byCat.set(key, cur);
  }
  view.categoryDistribution = Array.from(byCat.entries())
    .map(([category, v]) => ({ category, amountKopeks: v.amountKopeks, count: v.count }))
    .sort((a, b) => b.amountKopeks - a.amountKopeks);

  return view;
}
