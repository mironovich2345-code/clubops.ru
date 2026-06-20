import { NextResponse } from "next/server";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { getInvoiceForContext } from "@/lib/invoices";
import { readInvoiceFile } from "@/lib/invoice-storage";
import { wantsAttachment, dispositionHeader, isInitialDocumentRequest } from "@/lib/document-access";

export const dynamic = "force-dynamic";

// Streams the original invoice document, access-checked against the current
// scope. Never exposes the on-disk path; the storageKey stays server-side.
// Viewed inline by everyone with record access; the accounting contour may
// request an explicit download via ?download=1 (Content-Disposition: attachment).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const ctx = await getCurrentAccessContext();
  if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

  const invoice = await getInvoiceForContext(ctx, id);
  if (!invoice || !invoice.originalFileStorageKey) {
    return new NextResponse("Not found", { status: 404 });
  }

  const buffer = await readInvoiceFile(invoice.originalFileStorageKey);
  if (!buffer) return new NextResponse("Not found", { status: 404 });

  const attachment = wantsAttachment(req, ctx.effectiveRoles);

  if (isInitialDocumentRequest(req)) {
    await recordAudit({
      action: attachment ? "document.downloaded" : "document.viewed",
      entityType: "Invoice",
      entityId: invoice.id,
      companyId: invoice.companyId,
      clubId: invoice.clubId,
      userId: ctx.user.id,
      metadata: { documentType: "invoice" },
    });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": invoice.originalFileMime ?? "application/octet-stream",
      "Content-Disposition": dispositionHeader(attachment, invoice.originalFileName ?? "invoice"),
      "Cache-Control": "private, no-store",
    },
  });
}
