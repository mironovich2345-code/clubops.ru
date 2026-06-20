import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Structured business-data exports (CSV/XLSX of sales/expenses/invoices/refunds)
// have been removed from all business roles. This endpoint is disabled and
// returns 404 unconditionally — it never reveals whether records exist or
// whether the caller would have had access.
//
// The internal CSV builders (src/lib/exports.ts) are retained for possible
// future controlled administration but are NOT wired to any remote route.
export async function GET() {
  return new NextResponse("Not found", { status: 404 });
}
