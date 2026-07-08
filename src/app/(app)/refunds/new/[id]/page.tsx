import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational } from "@/lib/auth";
import { getRefundForContext, getActiveRefundDocuments } from "@/lib/refunds";
import { refundSlots, isRefundDocumentSetComplete, hasCompleteRequisites, REFUND_RETURN_TYPE_LABELS, type RefundReturnType } from "@/lib/refund-documents";
import { canPreviewInline } from "@/lib/refund-document-storage";
import { RefundDraftEditor } from "../../_components/RefundDraftEditor";

export const dynamic = "force-dynamic";

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export default async function RefundDraftPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("refunds");
  const { id } = await params;
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");

  const refund = await getRefundForContext(ctx, id); // company + allowed-club scope check
  // Only the v2 draft editor lives here; anything else opens in the record view.
  if (!refund || refund.entryVersion !== 2 || refund.status !== "draft") redirect(refund ? `/refunds/${id}` : "/refunds");
  const isCreator = refund.createdByUserId === ctx.user.id;
  const isRegional = ctx.effectiveRoles.includes("regional_director");
  if (!canCreateOperational(ctx.effectiveRoles) || (!isCreator && !isRegional)) redirect("/refunds");

  const returnType = (refund.returnType ?? "membership") as RefundReturnType;
  const active = await getActiveRefundDocuments(id);
  const byType = new Map(active.map((d) => [d.documentType, d]));
  const slots = refundSlots(returnType).map((s) => {
    const d = byType.get(s.key);
    return {
      key: s.key, label: s.label,
      doc: d ? {
        id: d.id, fileName: d.originalFilename, sizeText: sizeText(d.sizeBytes),
        isImage: d.mimeType.startsWith("image/") && canPreviewInline(d.mimeType),
        href: `/api/refunds/${id}/file?key=${encodeURIComponent(d.storageKey)}`,
      } : null,
    };
  });
  const requisites = {
    bankRecipientName: refund.bankRecipientName ?? "", bankName: refund.bankName ?? "",
    bankBik: refund.bankBik ?? "", bankAccount: refund.bankAccount ?? "", bankCorrAccount: refund.bankCorrAccount ?? "",
  };
  const canProceed = isRefundDocumentSetComplete(returnType, active.map((d) => d.documentType)) && hasCompleteRequisites(refund);

  return (
    <div>
      <PageHeader title="Новый возврат" description={`Черновик · ${REFUND_RETURN_TYPE_LABELS[returnType]}`} />
      <RefundDraftEditor refundId={id} returnType={returnType} slots={slots} requisites={requisites} canProceed={canProceed} />
    </div>
  );
}
