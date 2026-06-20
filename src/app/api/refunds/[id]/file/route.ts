import { NextResponse } from "next/server";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { getRefundForContext, parseRefundDocuments } from "@/lib/refunds";
import { readRefundFile } from "@/lib/refund-storage";
import { wantsAttachment, dispositionHeader, isInitialDocumentRequest } from "@/lib/document-access";

export const dynamic = "force-dynamic";

// Streams one refund document, access-checked against the current scope and
// verified to belong to the refund. The on-disk path is never exposed.
// Viewed inline by everyone with record access; the accounting contour may
// request an explicit download via ?download=1 (Content-Disposition: attachment).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return new NextResponse("Bad request", { status: 400 });

  const ctx = await getCurrentAccessContext();
  if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

  const refund = await getRefundForContext(ctx, id);
  if (!refund) return new NextResponse("Not found", { status: 404 });

  const doc = parseRefundDocuments(refund.documentsJson).find((d) => d.storageKey === key);
  if (!doc) return new NextResponse("Not found", { status: 404 });

  const buffer = await readRefundFile(doc.storageKey);
  if (!buffer) return new NextResponse("Not found", { status: 404 });

  const attachment = wantsAttachment(req, ctx.effectiveRoles);

  if (isInitialDocumentRequest(req)) {
    await recordAudit({
      action: attachment ? "document.downloaded" : "document.viewed",
      entityType: "Refund",
      entityId: refund.id,
      companyId: refund.companyId,
      clubId: refund.clubId,
      userId: ctx.user.id,
      metadata: { documentType: doc.type ?? "refund" },
    });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": doc.mime ?? "application/octet-stream",
      "Content-Disposition": dispositionHeader(attachment, doc.fileName ?? "document"),
      "Cache-Control": "private, no-store",
    },
  });
}
