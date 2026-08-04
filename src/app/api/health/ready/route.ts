import { NextResponse } from "next/server";
import { deploymentVersion } from "@/lib/deployment-version";
import { getReadiness } from "@/lib/health/readiness";

// REM-06 — READINESS: can we accept user traffic? Required deps = env contract + DB
// (connect + schema/migration compatibility + provider match) + storage (in
// production). Any required failure → HTTP 503 + status="not_ready" so the load
// balancer / orchestrator stops routing traffic. Checks are secret-free
// (DependencyCheckResult carries only codes/metadata). Bounded + cached + single-flight.
export const dynamic = "force-dynamic";

export async function GET() {
  let verdict;
  try {
    verdict = await getReadiness();
  } catch {
    // A crash in the readiness path itself is a not-ready signal, never a 200.
    return NextResponse.json(
      { status: "not_ready", ...deploymentVersion(), timestamp: new Date().toISOString(), checks: [{ name: "readiness", status: "failed", errorCode: "READINESS_ERROR" }] },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { status: verdict.status, ...deploymentVersion(), timestamp: new Date().toISOString(), checks: verdict.checks },
    { status: verdict.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
