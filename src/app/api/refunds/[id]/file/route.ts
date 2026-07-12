import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { getRefundForContext, parseRefundDocuments } from "@/lib/refunds";
import { readRefundFile } from "@/lib/refund-storage";
import { readRefundDocument } from "@/lib/refund-document-storage";
import { wantsAttachment, safeDownloadHeaders, isInitialDocumentRequest } from "@/lib/document-access";

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

  // Legacy v1 doc (documentsJson) first, then a v2 active RefundDocument.
  const legacy = parseRefundDocuments(refund.documentsJson).find((d) => d.storageKey === key);
  let buffer: Buffer | null = null;
  let fileName = "document";
  let docType = "refund";
  if (legacy) {
    buffer = await readRefundFile(legacy.storageKey);
    fileName = legacy.fileName ?? fileName; docType = legacy.type ?? docType;
  } else {
    const v2 = await prisma.refundDocument.findFirst({
      where: { refundId: refund.id, storageKey: key, removedAt: null },
      select: { storageKey: true, mimeType: true, originalFilename: true, documentType: true },
    });
    if (v2) {
      buffer = await readRefundDocument(v2.storageKey);
      fileName = v2.originalFilename; docType = v2.documentType;
    }
  }
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
      metadata: { documentType: docType },
    });
  }

  return new NextResponse(new Uint8Array(buffer), {
    // Safe content type from the (server-generated) storage key + nosniff. `key`
    // is already validated to belong to this refund's own documents.
    headers: safeDownloadHeaders(key, fileName, attachment),
  });
}
