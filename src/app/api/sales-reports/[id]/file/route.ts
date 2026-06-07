import { NextResponse } from "next/server";
import { getCurrentAccessContext } from "@/lib/access";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { getSalesReportForContext } from "@/lib/sales-reports";
import { readReportFile } from "@/lib/sales-report-storage";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return new NextResponse("Bad request", { status: 400 });

  const ctx = await getCurrentAccessContext();
  if (!ctx) return new NextResponse("Unauthorized", { status: 401 });
  // Documents are restricted to roles that can see the sales page (marketer cannot).
  if (!canAnyRoleAccessPage(ctx.effectiveRoles, "sales")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const report = await getSalesReportForContext(ctx, id);
  if (!report) return new NextResponse("Not found", { status: 404 });

  const doc = report.documents.find((d) => d.storageKey === key);
  if (!doc || !doc.storageKey) return new NextResponse("Not found", { status: 404 });

  const buffer = await readReportFile(doc.storageKey);
  if (!buffer) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": doc.originalFileMime || "application/octet-stream",
      "Content-Disposition": `inline; filename="${encodeURIComponent(doc.originalFileName || "document")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
