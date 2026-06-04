import { NextResponse } from "next/server";

// Liveness probe for Docker / orchestrators / load balancers. Intentionally
// dependency-free (no DB call) so it reports the app process being up and does
// not flap while migrations run or the DB briefly reconnects.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", service: "club-ops", time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
