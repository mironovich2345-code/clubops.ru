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
  getInvoiceOperationalMonth,
  isInvoiceOverdue,
  canAddPaidInvoice,
} from "@/lib/invoices";
import { formatUserDisplayName } from "@/lib/user-display";

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

// A row in the month-independent «Ожидают проверки» regional queue.
export type InvoiceReviewRow = {
  id: string;
  clubId: string;
  clubName: string;
  city: string;
  counterpartyName: string | null;
  invoiceNumber: string | null;
  amountKopeks: number;
  status: string;
  createdByUserId: string;
  createdByName: string;
  dueDate: string | null;
  submittedAt: string | null;
  createdAt: string;
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
  // «Ожидают проверки» — all needs_review in scope, INDEPENDENT of the selected
  // month (only populated for roles that review: elevated). Empty for managers.
  regionalReviewQueue: InvoiceReviewRow[];
  showReviewQueue: boolean;
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
    currentPeriodInvoices: [], carriedOverdueInvoices: [],
    regionalReviewQueue: [], showReviewQueue: roleView === "elevated",
    categoryDistribution: [], permissions,
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
  // Managers also see their own operational work-in-progress (drafts + rejected)
  // so a saved draft never disappears. Elevated roles don't get drafts in the
  // period list — they act on the dedicated review queue instead.
  // Managers additionally see their own drafts/rejected (empty for elevated).
  const managerExtraStatuses = roleView === "manager" ? ["draft", "rejected"] : [];
  const incl = { club: { select: { id: true, name: true, city: true } } } as const;
  // Review queue clubs: ALL accessible clubs of the company (never narrowed by the
  // city/club filter); empty for non-elevated so the query returns nothing.
  const reviewClubIds = isElevated ? availableClubs.map((c) => c.id) : [];

  // Bounded queries: paid-in-month, open obligations, manager drafts/rejected,
  // and (elevated only) the month-independent needs_review review queue. Each uses
  // an empty `in` filter when not applicable, so we never over-fetch.
  const [paidInMonth, liveUnpaid, managerExtra, reviewQueueRaw] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, clubId: { in: clubIds }, ...creatorFilter, status: "paid", paidAt: { gte: start, lt: end } },
      include: incl,
    }),
    prisma.invoice.findMany({
      where: { companyId, clubId: { in: clubIds }, ...creatorFilter, status: { in: LIVE } },
      include: incl,
    }),
    prisma.invoice.findMany({
      where: { companyId, clubId: { in: clubIds }, ...creatorFilter, status: { in: managerExtraStatuses } },
      include: incl,
    }),
    // Review queue: needs_review across accessible clubs — deliberately NOT bound
    // by the selected month or the city/club filter, so a pending invoice can
    // never be missed.
    prisma.invoice.findMany({
      where: { companyId, clubId: { in: reviewClubIds }, status: "needs_review" },
      include: { ...incl, createdBy: { select: { name: true, firstName: true, lastName: true, deletedAt: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const rowOf = (inv: (typeof paidInMonth)[number]): InvoiceReportingRow => ({
    id: inv.id, clubId: inv.clubId, clubName: inv.club.name, city: inv.club.city,
    counterpartyName: inv.counterpartyName, invoiceNumber: inv.invoiceNumber,
    amountKopeks: inv.amountKopeks, expenseCategory: inv.expenseCategory, status: inv.status,
    dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
    paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
    // Operational month for list membership (draft/needs_review never hidden by a
    // missing dueDate). Financial analytics elsewhere keep their own date rules.
    reportingMonth: getInvoiceOperationalMonth(inv), overdue: isInvoiceOverdue(inv, now),
    createdByUserId: inv.createdByUserId,
  });

  const paidRows = paidInMonth.map(rowOf); // reporting month = paidAt month = selKey
  const unpaidRows = liveUnpaid.map(rowOf);
  const extraRows = managerExtra.map(rowOf);
  const currentUnpaid = unpaidRows.filter((r) => r.reportingMonth === selKey);
  const currentExtra = extraRows.filter((r) => r.reportingMonth === selKey);
  const currentPeriodInvoices = [...paidRows, ...currentUnpaid, ...currentExtra];
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

  // Financial rows for totals / distribution exclude operational-only rows
  // (draft / rejected) — those are visible but are not committed spending.
  const financialRows = currentPeriodInvoices.filter((r) => r.status !== "draft" && r.status !== "rejected");

  view.currentPeriodInvoices = currentPeriodInvoices;
  view.carriedOverdueInvoices = carriedOverdueInvoices;
  view.summary = roleView === "manager"
    ? { pendingPaymentAmountKopeks, overdueAmountKopeks, sentCount }
    : { pendingPaymentAmountKopeks, overdueAmountKopeks, sentCount, totalInvoiceAmountKopeks: sum(financialRows), paidAmountKopeks: sum(paidRows) };

  // Submission times for the review queue (latest invoice.sent_to_review per
  // invoice) — month-independent, display only.
  const submittedAtById = new Map<string, string>();
  if (reviewQueueRaw.length > 0) {
    const sub = await prisma.auditLog.findMany({
      where: { action: "invoice.sent_to_review", entityId: { in: reviewQueueRaw.map((i) => i.id) } },
      select: { entityId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    for (const a of sub) if (a.entityId && !submittedAtById.has(a.entityId)) submittedAtById.set(a.entityId, a.createdAt.toISOString());
  }

  // Month-independent review queue rows (elevated only). Ordered oldest-first so
  // the longest-waiting invoice is at the top.
  view.regionalReviewQueue = reviewQueueRaw.map((inv) => {
    const withCreator = inv as (typeof reviewQueueRaw)[number] & {
      createdBy?: { name: string | null; firstName: string | null; lastName: string | null; deletedAt: Date | null } | null;
    };
    return {
      id: inv.id, clubId: inv.clubId, clubName: inv.club.name, city: inv.club.city,
      counterpartyName: inv.counterpartyName, invoiceNumber: inv.invoiceNumber,
      amountKopeks: inv.amountKopeks, status: inv.status, createdByUserId: inv.createdByUserId,
      createdByName: formatUserDisplayName(withCreator.createdBy ?? null),
      dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
      submittedAt: submittedAtById.get(inv.id) ?? null,
      createdAt: inv.createdAt.toISOString(),
    };
  });
  view.showReviewQueue = roleView === "elevated";

  // Category distribution over the current-period FINANCIAL set only (carried
  // debt stays in its own overdue block; drafts/rejected are excluded).
  const byCat = new Map<string, { amountKopeks: number; count: number }>();
  for (const r of financialRows) {
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
