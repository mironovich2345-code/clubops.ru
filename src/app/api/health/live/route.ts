import { NextResponse } from "next/server";
import { deploymentVersion } from "@/lib/deployment-version";

// REM-06 — LIVENESS only. Reports the process is up + deployment metadata. NEVER
// touches DB/S3/SMTP/AI/OFD, so it does not flap while migrations run or the DB
// reconnects. Orchestrator restart signals should use this; traffic gating uses
// /api/health/ready. No secrets (see deployment-version.ts).
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "alive", ...deploymentVersion(), timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
