import { NextResponse } from "next/server";
import { getCurrentAccessContext, recordAudit } from "@/lib/access";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { getSalesReportForContext } from "@/lib/sales-reports";
import { readReportFile } from "@/lib/sales-report-storage";
import { wantsAttachment, safeDownloadHeaders, isInitialDocumentRequest } from "@/lib/document-access";

export const dynamic = "force-dynamic";

// Sales-report documents (КМ-6 ООО / ИП, encashment, withdrawal, reports).
// Viewed inline by every role that can see the sales page (marketer cannot);
// the accounting contour may request an explicit download via ?download=1.
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

  const attachment = wantsAttachment(req, ctx.effectiveRoles);

  if (isInitialDocumentRequest(req)) {
    await recordAudit({
      action: attachment ? "document.downloaded" : "document.viewed",
      entityType: "SalesReport",
      entityId: report.id,
      companyId: report.companyId,
      clubId: report.clubId,
      userId: ctx.user.id,
      metadata: { documentType: doc.type ?? "sales_report_document" },
    });
  }

  return new NextResponse(new Uint8Array(buffer), {
    // Safe content type from the storage-key extension + nosniff. Office/csv/heic
    // report docs are not in the inline allowlist, so they download as attachments.
    headers: safeDownloadHeaders(doc.storageKey, doc.originalFileName || "document", attachment),
  });
}
