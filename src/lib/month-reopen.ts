// Controlled month-reopening workflow. The Chief Accountant requests a reopen
// for a closed month; the Owner approves/rejects; the Chief Accountant executes
// an approved request, which reopens the MonthClose. Direct reopening is not
// possible. Scope mirrors MonthClose (clubId null = company-wide).
import { prisma } from "@/lib/prisma";

export type ReopenStatus = "pending" | "approved" | "rejected" | "executed" | "canceled";

// A scope+month may have at most one request in an "active" state.
export const REOPEN_ACTIVE_STATUSES: ReopenStatus[] = ["pending", "approved"];

export const REOPEN_STATUS_LABELS: Record<string, string> = {
  pending: "Ожидает согласования собственника",
  approved: "Переоткрытие согласовано",
  rejected: "Отклонено",
  executed: "Переоткрыт",
  canceled: "Отменено",
};

export type ReopenRequest = {
  id: string;
  companyId: string;
  clubId: string | null;
  month: string;
  status: ReopenStatus;
  reason: string;
  requestedByUserId: string;
  requestedAt: Date;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  reviewComment: string | null;
  executedByUserId: string | null;
  executedAt: Date | null;
};

export type ReopenRequestView = ReopenRequest & {
  requestedByName: string | null;
  reviewedByName: string | null;
  clubName: string | null;
};

/** The single active (pending|approved) request for a scope+month, if any. */
export async function getActiveReopenRequest(
  companyId: string,
  clubId: string | null,
  month: string,
): Promise<ReopenRequest | null> {
  return prisma.monthReopenRequest.findFirst({
    where: { companyId, clubId, month, status: { in: REOPEN_ACTIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
  }) as Promise<ReopenRequest | null>;
}

/** The most recent request (any status) for a scope+month, with display names. */
export async function getLatestReopenRequestView(
  companyId: string,
  clubId: string | null,
  month: string,
): Promise<ReopenRequestView | null> {
  const req = await prisma.monthReopenRequest.findFirst({
    where: { companyId, clubId, month },
    orderBy: { createdAt: "desc" },
  });
  if (!req) return null;
  return decorateRequest(req as ReopenRequest);
}

/** All pending requests in a company — the Owner approval queue. */
export async function getPendingReopenRequestsForCompany(companyId: string): Promise<ReopenRequestView[]> {
  return getPendingReopenRequestsForCompanies([companyId]);
}

/** Pending requests across ANY set of accessible companies (strategic owner view).
 * One scoped query (companyId IN). Caller passes only accessible company ids. */
export async function getPendingReopenRequestsForCompanies(companyIds: string[]): Promise<ReopenRequestView[]> {
  if (companyIds.length === 0) return [];
  const rows = await prisma.monthReopenRequest.findMany({
    where: { companyId: { in: companyIds }, status: "pending" },
    orderBy: { requestedAt: "asc" },
  });
  return Promise.all(rows.map((r) => decorateRequest(r as ReopenRequest)));
}

async function decorateRequest(req: ReopenRequest): Promise<ReopenRequestView> {
  const userIds = [req.requestedByUserId, req.reviewedByUserId].filter((x): x is string => !!x);
  const [users, club] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    req.clubId ? prisma.club.findUnique({ where: { id: req.clubId }, select: { name: true } }) : Promise.resolve(null),
  ]);
  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);
  return {
    ...req,
    requestedByName: nameOf(req.requestedByUserId),
    reviewedByName: nameOf(req.reviewedByUserId),
    clubName: club?.name ?? null,
  };
}
