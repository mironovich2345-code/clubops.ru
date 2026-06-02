import { NextResponse } from "next/server";
import { getCurrentAccessContext } from "@/lib/access";
import { getExpenseForContext } from "@/lib/expenses";
import { readExpenseFile } from "@/lib/expense-storage";

export const dynamic = "force-dynamic";

// Streams the original expense document, access-checked against the current
// scope. Never exposes the on-disk path; the storageKey stays server-side.
export async function GET(
  _req: Request,
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

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": expense.originalFileMime ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(
        expense.originalFileName ?? "expense",
      )}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
