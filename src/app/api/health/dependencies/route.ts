import { NextResponse } from "next/server";
import { deploymentVersion } from "@/lib/deployment-version";
import { getDependencies } from "@/lib/health/dependencies";

// REM-06 — operational DIAGNOSTICS: DB, storage, SMTP, AI, OFD, backup, scheduler.
// Sanitized — codes/metadata only, NO hosts/credentials/bucket/DB names/paths/stacks.
// Optional integrations report `degraded`, never blocking readiness. Always HTTP 200
// (it is a diagnostic surface, not a traffic gate).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const report = await getDependencies();
    return NextResponse.json(
      { ...deploymentVersion(), timestamp: new Date().toISOString(), overall: report.overall, checks: report.checks },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ...deploymentVersion(), timestamp: new Date().toISOString(), overall: "unknown", checks: [{ name: "dependencies", status: "unknown", errorCode: "DIAGNOSTICS_ERROR" }] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
