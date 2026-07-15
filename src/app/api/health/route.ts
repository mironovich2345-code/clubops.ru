import { NextResponse } from "next/server";
import { deploymentVersion } from "@/lib/deployment-version";
import { storageProviderName } from "@/lib/storage";
import { emailConfigured } from "@/lib/email";
import { selectedAiProvider } from "@/lib/ai/openai-client";
import { telegramHealth } from "@/lib/telegram/config";
import { ofdHealth } from "@/lib/ofd/config";

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
  // AI readiness — provider NAMES only, never keys. `requested` is AI_PROVIDER as
  // set; `effective` is what actually runs (falls back to "mock" if a requested
  // provider is missing its credentials); `configured` is true when the requested
  // provider is fully wired (or when none was requested).
  const requested = process.env.AI_PROVIDER || "mock";
  const effective = selectedAiProvider();
  const ai = { requested, effective, configured: requested === "mock" ? true : requested === effective };

  return NextResponse.json(
    { status: "ok", service: "club-ops", time: new Date().toISOString(), ...deploymentVersion(), storage: storageProviderName(), email: emailConfigured() ? "configured" : "absent", ai, telegram: telegramHealth(), ofd: ofdHealth() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
