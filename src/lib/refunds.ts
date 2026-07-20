import type { Refund } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import { managerCannotSeeRecord } from "@/lib/access";
import type { ApprovalAction } from "@/lib/approval";

export const REFUND_DOC_TYPES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "contract", label: "Договор" },
  { key: "statement", label: "Заявление" },
  { key: "requisites", label: "Реквизиты" },
  { key: "receipt", label: "Чек" },
  { key: "other", label: "Прочее" },
];

export const REFUND_DOC_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  REFUND_DOC_TYPES.map((t) => [t.key, t.label]),
);

export type RefundDocument = {
  storageKey: string;
  fileName: string;
  mime: string;
  size: number;
  type: string;
};

export const REFUND_ACTION_AUDIT: Record<ApprovalAction, string> = {
  send_to_review: "refund.sent_to_review",
  approve: "refund.approved",
  reject: "refund.rejected",
  pay: "refund.paid",
};

export type RefundWithClub = Refund & {
  club: { id: string; name: string; city: string };
  createdBy: { id: string; name: string };
};

export async function getRefundsForScope(
  scope: DataScope,
  // When set (a manager-only actor), limits the list to refunds that user
  // created. Elevated actors omit it and see all refunds of their clubs.
  restrictToCreatorId?: string,
): Promise<RefundWithClub[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const refunds = await prisma.refund.findMany({
    where: {
      companyId: scope.company.id, clubId: { in: scope.clubIds },
      ...(restrictToCreatorId ? { createdByUserId: restrictToCreatorId } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      club: { select: { id: true, name: true, city: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  return refunds as RefundWithClub[];
}

export async function getRefundForContext(
  ctx: AccessContext,
  refundId: string,
): Promise<RefundWithClub | null> {
  if (!ctx.selectedCompanyId) return null;
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: {
      club: { select: { id: true, name: true, city: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  if (!refund) return null;
  if (refund.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(refund.clubId)) return null;
  // A plain manager sees only refunds they created (own-only, server-enforced).
  if (managerCannotSeeRecord(ctx, refund)) return null;
  return refund as RefundWithClub;
}

export function parseRefundDocuments(json: string | null): RefundDocument[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as RefundDocument[]) : [];
  } catch {
    return [];
  }
}

// --- v2 slot documents (RefundDocument table) -------------------------------

export type ActiveRefundDoc = {
  id: string;
  documentType: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
};

/** Active (non-removed) v2 slot documents for a refund. */
export async function getActiveRefundDocuments(refundId: string): Promise<ActiveRefundDoc[]> {
  return prisma.refundDocument.findMany({
    where: { refundId, removedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, documentType: true, originalFilename: true, safeFilename: true, mimeType: true, sizeBytes: true, storageKey: true },
  });
}

// --- PT trainers (ClubEmployee, this club only; active + dismissed) ----------

export const REFUND_TRAINER_POSITIONS = ["gym_trainer", "group_trainer"] as const;
export type RefundTrainer = { id: string; fullName: string; position: string; status: string };

/** Trainers tied to THIS club (active first, then dismissed). No other club's
 * employees and no personal data beyond the display name. */
export async function getClubTrainers(clubId: string): Promise<RefundTrainer[]> {
  return prisma.clubEmployee.findMany({
    where: { clubId, position: { in: REFUND_TRAINER_POSITIONS as unknown as string[] } },
    orderBy: [{ status: "asc" }, { fullName: "asc" }],
    select: { id: true, fullName: true, position: true, status: true },
  });
}

// --- Legal entities available for a refund payment --------------------------

export type ClubLegalEntityOption = { id: string; name: string; type: string };

/** Active legal entities linked to THIS club (via an active ClubLegalEntity) within
 * the company. Drives the payment legal-entity picker; the pay action re-validates
 * the chosen id against the same constraint. */
export async function getClubActiveLegalEntities(clubId: string, companyId: string): Promise<ClubLegalEntityOption[]> {
  const rows = await prisma.clubLegalEntity.findMany({
    where: { clubId, isActive: true, legalEntity: { isActive: true, companyId } },
    select: { legalEntity: { select: { id: true, name: true, shortName: true, type: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.legalEntity.id, name: r.legalEntity.shortName || r.legalEntity.name, type: r.legalEntity.type }));
}

/** Validate a chosen trainer belongs to the club (any status) + is a trainer. */
export async function getClubTrainer(clubId: string, employeeId: string): Promise<RefundTrainer | null> {
  const e = await prisma.clubEmployee.findFirst({
    where: { id: employeeId, clubId, position: { in: REFUND_TRAINER_POSITIONS as unknown as string[] } },
    select: { id: true, fullName: true, position: true, status: true },
  });
  return e ?? null;
}
