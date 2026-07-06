import { NextResponse } from "next/server";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { getExpenseForContext } from "@/lib/expenses";
import { readExpenseDocument, canPreviewInline } from "@/lib/expense-document-storage";
import { wantsAttachment, dispositionHeader, isInitialDocumentRequest } from "@/lib/document-access";

export const dynamic = "force-dynamic";

// Streams one ExpenseDocument, authorized at the final object query. Foreign or
// removed documents are indistinguishable from missing (always 404) so existence
// is never leaked. The storageKey stays server-side; no public/permanent link.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;

  const ctx = await getCurrentAccessContext();
  if (!ctx) return new NextResponse("Unauthorized", { status: 401 });

  const expense = await getExpenseForContext(ctx, id); // company + club scope
  if (!expense) return new NextResponse("Not found", { status: 404 });

  const { prisma } = await import("@/lib/prisma");
  const doc = await prisma.expenseDocument.findUnique({ where: { id: docId } });
  if (!doc || doc.expenseId !== expense.id || doc.removedAt) return new NextResponse("Not found", { status: 404 });
  // Defensive: the document's stored scope must match the expense's scope.
  if (doc.companyId !== expense.companyId || doc.clubId !== expense.clubId) return new NextResponse("Not found", { status: 404 });

  const buffer = await readExpenseDocument(doc.storageKey);
  if (!buffer) return new NextResponse("Not found", { status: 404 });

  // Accounting contour may download; others view inline. Non-previewable types
  // (e.g. webp) are always served as a download.
  const attachment = wantsAttachment(req, ctx.effectiveRoles) || !canPreviewInline(doc.mimeType);

  if (isInitialDocumentRequest(req)) {
    await recordAudit({
      action: attachment ? "expense.document_downloaded" : "expense.document_viewed",
      entityType: "ExpenseDocument", entityId: doc.id,
      companyId: expense.companyId, clubId: expense.clubId, userId: ctx.user.id,
      metadata: { expenseId: expense.id, mimeCategory: doc.mimeType.split("/")[0], sizeBytes: doc.sizeBytes },
    });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Disposition": dispositionHeader(attachment, doc.safeFilename || "document"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
