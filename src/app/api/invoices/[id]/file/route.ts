import { NextResponse } from "next/server";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { getInvoiceForContext } from "@/lib/invoices";
import { readInvoiceFile, storageKeyHash, storageProviderName } from "@/lib/invoice-storage";
import { wantsAttachment, safeDownloadHeaders, isInitialDocumentRequest } from "@/lib/document-access";

export const dynamic = "force-dynamic";

// Controlled 404 for the download endpoint — a plain-text reason + machine code
// header, never a bare "Not found". Distinguishes the three cases so the UI (and
// a direct URL open) shows a meaningful message.
function fileError(code: "INVOICE_FILE_NO_METADATA" | "INVOICE_FILE_NOT_FOUND", message: string) {
  return new NextResponse(message, {
    status: 404,
    headers: { "X-Error-Code": code, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}

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

  // A. Invoice missing or out of scope → generic 404 (never reveal existence).
  const invoice = await getInvoiceForContext(ctx, id);
  if (!invoice) return new NextResponse("Not found", { status: 404 });

  // B. Invoice exists but no file was ever attached (metadata absent).
  if (!invoice.originalFileStorageKey) {
    return fileError("INVOICE_FILE_NO_METADATA", "К счёту не прикреплён файл.");
  }

  // C. Metadata present but the object is gone from storage (e.g. lost on an
  // ephemeral filesystem after a redeploy). Controlled error + safe log — never
  // the storageKey, bucket, credentials or file contents.
  const buffer = await readInvoiceFile(invoice.originalFileStorageKey);
  if (!buffer) {
    console.warn("invoice.file.missing", JSON.stringify({
      route: "GET /api/invoices/[id]/file",
      invoiceId: invoice.id, userId: ctx.user.id, companyId: invoice.companyId, clubId: invoice.clubId,
      provider: storageProviderName(), metadataFound: true, storageObjectFound: false,
      keyHash: storageKeyHash(invoice.originalFileStorageKey), errorCode: "INVOICE_FILE_NOT_FOUND",
    }));
    return fileError("INVOICE_FILE_NOT_FOUND", "Файл счёта не найден в хранилище. Данные счёта сохранены, но исходный документ недоступен.");
  }

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
    // Safe content type derived from the storage-key extension (never the client
    // MIME) + nosniff + attachment for non-inline types (stored-XSS hardening).
    headers: safeDownloadHeaders(invoice.originalFileStorageKey, invoice.originalFileName ?? "invoice", attachment),
  });
}
