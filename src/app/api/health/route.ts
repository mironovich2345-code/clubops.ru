import { NextResponse } from "next/server";
import { deploymentVersion } from "@/lib/deployment-version";
import { storageProviderName } from "@/lib/storage";

// Liveness probe for Docker / orchestrators / load balancers. Intentionally
// dependency-free (no DB call) so it reports the app process being up and does
// not flap while migrations run or the DB briefly reconnects. Also exposes the
// current deployment's technical version identifiers (commit / deployment id /
// environment) and the active storage provider NAME ("local" | "s3") so we can
// verify which Git commit is live and whether files use persistent storage —
// see deployment-version.ts for the strict "no secrets" contract. Only the
// provider name is exposed; never the bucket, endpoint, keys or region.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", service: "club-ops", time: new Date().toISOString(), ...deploymentVersion(), storage: storageProviderName() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
