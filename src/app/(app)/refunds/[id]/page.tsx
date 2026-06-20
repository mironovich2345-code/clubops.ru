import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canDownloadDocuments } from "@/lib/auth";
import {
  getRefundForContext,
  parseRefundDocuments,
  REFUND_DOC_TYPE_LABELS,
} from "@/lib/refunds";
import {
  availableApprovalActions,
  canEditApproval,
  APPROVAL_ACTION_LABELS,
  APPROVAL_STATUS_LABELS,
} from "@/lib/approval";
import { RefundEditForm } from "./_components/RefundEditForm";

export const dynamic = "force-dynamic";

function isoDay(date: Date | null): string {
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default async function RefundDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("refunds");
  const { id } = await params;

  const ctx = await getCurrentAccessContext();
  if (!ctx) notFound();

  const refund = await getRefundForContext(ctx, id);
  if (!refund) notFound();

  const documents = parseRefundDocuments(refund.documentsJson).map((d) => ({
    storageKey: d.storageKey,
    fileName: d.fileName,
    typeLabel: REFUND_DOC_TYPE_LABELS[d.type] ?? d.type,
  }));

  const view = {
    id: refund.id,
    clientName: refund.clientName ?? "",
    clientPhone: refund.clientPhone ?? "",
    amount: (refund.amountKopeks / 100).toString(),
    currency: refund.currency,
    reason: refund.reason ?? "",
    contractNumber: refund.contractNumber ?? "",
    refundDate: isoDay(refund.refundDate),
    bankRecipientName: refund.bankRecipientName ?? "",
    bankName: refund.bankName ?? "",
    bankBik: refund.bankBik ?? "",
    bankAccount: refund.bankAccount ?? "",
    notes: refund.notes ?? "",
    clubName: refund.club.name,
    documents,
    // Accounting contour only: explicit download (attachment). Others view inline.
    canDownload: canDownloadDocuments(ctx.effectiveRoles),
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <PageHeader
          title="Возврат"
          description={`${view.clubName} · ${APPROVAL_STATUS_LABELS[refund.status] ?? refund.status}`}
        />
        <Link
          href="/refunds"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          К списку
        </Link>
      </div>

      <RefundEditForm
        refund={view}
        availableActions={availableApprovalActions(refund.status, ctx.effectiveRoles)}
        actionLabels={APPROVAL_ACTION_LABELS}
        statusLabel={APPROVAL_STATUS_LABELS[refund.status] ?? refund.status}
        canEdit={canEditApproval(refund.status, ctx.effectiveRoles)}
      />
    </div>
  );
}
