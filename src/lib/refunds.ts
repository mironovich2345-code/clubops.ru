import type { Refund } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
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

export async function getRefundsForScope(scope: DataScope): Promise<RefundWithClub[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const refunds = await prisma.refund.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
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
