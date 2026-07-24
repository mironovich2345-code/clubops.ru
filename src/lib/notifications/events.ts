// Workflow → notification bridge. Resolves recipients and enqueues SAFE outbox
// rows for expense / invoice / refund transitions. Every function is best-effort:
// it swallows its own errors and NEVER throws into the calling business action.
// No document content, requisites, client PII, comments, OCR text or storage keys
// ever reach the payload or the logs.
import { prisma } from "@/lib/prisma";
import { telegramEnabled } from "@/lib/telegram/config";
import { enqueueNotification } from "@/lib/notifications/outbox";

type ResourceType = "expense" | "invoice" | "refund" | "payroll";

/**
 * Notify a club's regional director(s) about a daily-cash discrepancy or overdue
 * confirmation. Best-effort: swallows its own errors, never blocks the caller.
 */
export async function notifyReconciliation(params: {
  event: "discrepancy" | "overdue";
  clubId: string;
  companyId: string;
  amountKopeks: number;
  actorUserId: string;
  extraRecipientUserIds?: string[];
}): Promise<void> {
  if (!telegramEnabled()) return;
  try {
    const regionals = await getRegionalRecipientUserIds(params.companyId, params.clubId, params.actorUserId);
    const recipients = [...new Set([...regionals, ...(params.extraRecipientUserIds ?? [])])].filter((id) => id !== params.actorUserId);
    if (recipients.length === 0) {
      notifLog({ event: `reconciliation_${params.event}`, result: "no_recipient" });
      return;
    }
    const name = await clubName(params.clubId);
    for (const recipientUserId of recipients) {
      await enqueueNotification({
        type: `reconciliation.${params.event}`,
        recipientUserId,
        resourceType: "reconciliation",
        resourceId: params.clubId,
        companyId: params.companyId,
        clubId: params.clubId,
        payload: { resourceType: "reconciliation", clubName: name, amountKopeks: params.amountKopeks },
      });
    }
    notifLog({ event: `reconciliation_${params.event}`, recipients: recipients.length });
  } catch (error) {
    notifLog({ event: `reconciliation_${params.event}`, result: "error", code: (error as { code?: string })?.code });
  }
}

/** Safe, structured log line (no chatId / PII / message text). */
function notifLog(fields: Record<string, unknown>): void {
  try {
    console.warn(JSON.stringify({ scope: "notifications", ...fields }));
  } catch {
    /* logging must never throw */
  }
}

async function clubName(clubId: string | null): Promise<string> {
  if (!clubId) return "—";
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
  return club?.name ?? "—";
}

/**
 * Distinct ACTIVE regional-director user ids for a club: club-level assignments
 * for this club + company-level regional directors (who cover every club).
 * Excludes the actor (never notify yourself).
 */
export async function getRegionalRecipientUserIds(
  companyId: string,
  clubId: string,
  excludeUserId: string,
): Promise<string[]> {
  const [clubRows, companyRows] = await Promise.all([
    prisma.clubUserAccess.findMany({ where: { clubId, role: "regional_director", user: { isActive: true } }, select: { userId: true } }),
    prisma.companyUserAccess.findMany({ where: { companyId, role: "regional_director", user: { isActive: true } }, select: { userId: true } }),
  ]);
  const ids = new Set<string>([...clubRows.map((r) => r.userId), ...companyRows.map((r) => r.userId)]);
  ids.delete(excludeUserId);
  return [...ids];
}

type RegionalReviewParams = {
  resourceType: ResourceType;
  resourceId: string;
  companyId: string;
  clubId: string;
  amountKopeks: number;
  actorUserId: string;
  isResubmit: boolean;
};

/** Notify the club's regional director(s) that a record awaits their review. */
export async function notifyRegionalReview(params: RegionalReviewParams): Promise<void> {
  if (!telegramEnabled()) return;
  try {
    const recipients = await getRegionalRecipientUserIds(params.companyId, params.clubId, params.actorUserId);
    if (recipients.length === 0) {
      notifLog({ event: "regional_review", resourceType: params.resourceType, result: "no_recipient" });
      return;
    }
    const name = await clubName(params.clubId);
    const type = `${params.resourceType}.${params.isResubmit ? "resubmitted_review" : "submitted_review"}`;
    for (const recipientUserId of recipients) {
      await enqueueNotification({
        type,
        recipientUserId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        companyId: params.companyId,
        clubId: params.clubId,
        payload: { resourceType: params.resourceType, clubName: name, amountKopeks: params.amountKopeks },
      });
    }
    notifLog({ event: "regional_review", resourceType: params.resourceType, recipients: recipients.length, resubmit: params.isResubmit });
  } catch (error) {
    notifLog({ event: "regional_review", resourceType: params.resourceType, result: "error", code: (error as { code?: string })?.code });
  }
}

type AuthorParams = {
  resourceType: ResourceType;
  resourceId: string;
  companyId: string;
  clubId: string;
  amountKopeks: number;
  authorUserId: string;
  actorUserId: string;
  event: "returned" | "approved";
};

/** Notify the record's author that it was returned for correction or approved. */
export async function notifyAuthor(params: AuthorParams): Promise<void> {
  if (!telegramEnabled()) return;
  // Never notify yourself (e.g. a regional acting on their own record).
  if (params.authorUserId === params.actorUserId) return;
  try {
    const name = await clubName(params.clubId);
    await enqueueNotification({
      type: `${params.resourceType}.${params.event}`,
      recipientUserId: params.authorUserId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      companyId: params.companyId,
      clubId: params.clubId,
      payload: { resourceType: params.resourceType, clubName: name, amountKopeks: params.amountKopeks },
    });
    notifLog({ event: `author_${params.event}`, resourceType: params.resourceType });
  } catch (error) {
    notifLog({ event: `author_${params.event}`, resourceType: params.resourceType, result: "error", code: (error as { code?: string })?.code });
  }
}
