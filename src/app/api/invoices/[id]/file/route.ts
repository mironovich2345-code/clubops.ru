import { NextResponse } from "next/server";
import { getCurrentAccessContext } from "@/lib/access";
import { getInvoiceForContext } from "@/lib/invoices";
import { readInvoiceFile } from "@/lib/invoice-storage";

export const dynamic = "force-dynamic";

// Streams the original invoice document, access-checked against the current
// scope. Never exposes the on-disk path; the storageKey stays server-side.
export async function GET(
  _req: Request,
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

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": invoice.originalFileMime ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(
        invoice.originalFileName ?? "invoice",
      )}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
