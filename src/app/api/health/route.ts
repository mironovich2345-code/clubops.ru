import { NextResponse } from "next/server";
import { deploymentVersion } from "@/lib/deployment-version";

// Liveness probe for Docker / orchestrators / load balancers. Intentionally
// dependency-free (no DB call) so it reports the app process being up and does
// not flap while migrations run or the DB briefly reconnects. Also exposes the
// current deployment's technical version identifiers (commit / deployment id /
// environment) so we can verify which Git commit is live — see
// deployment-version.ts for the strict "no secrets" contract.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", service: "club-ops", time: new Date().toISOString(), ...deploymentVersion() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
