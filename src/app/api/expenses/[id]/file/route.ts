import { NextResponse } from "next/server";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { getExpenseForContext } from "@/lib/expenses";
import { readExpenseFile } from "@/lib/expense-storage";
import { wantsAttachment, dispositionHeader, isInitialDocumentRequest } from "@/lib/document-access";

export const dynamic = "force-dynamic";

// Streams the original expense document, access-checked against the current
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

  const expense = await getExpenseForContext(ctx, id);
  if (!expense || !expense.originalFileStorageKey) {
    return new NextResponse("Not found", { status: 404 });
  }

  const buffer = await readExpenseFile(expense.originalFileStorageKey);
  if (!buffer) return new NextResponse("Not found", { status: 404 });

  const attachment = wantsAttachment(req, ctx.effectiveRoles);

  if (isInitialDocumentRequest(req)) {
    await recordAudit({
      action: attachment ? "document.downloaded" : "document.viewed",
      entityType: "Expense",
      entityId: expense.id,
      companyId: expense.companyId,
      clubId: expense.clubId,
      userId: ctx.user.id,
      metadata: { documentType: expense.type ?? "receipt" },
    });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": expense.originalFileMime ?? "application/octet-stream",
      "Content-Disposition": dispositionHeader(attachment, expense.originalFileName ?? "expense"),
      "Cache-Control": "private, no-store",
    },
  });
}
