import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Structured analytics export (CSV of the expense category drilldown) has been
// removed from all business roles. This endpoint is disabled and returns 404
// unconditionally — it never reveals whether records exist or whether the caller
// would have had access. The drilldown remains viewable inline on the page.
export async function GET() {
  return new NextResponse("Not found", { status: 404 });
}
