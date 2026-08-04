import { NextResponse } from "next/server";
import { ofdEnabled } from "@/lib/ofd/config";
import { authorizeOfdCron, ofdCronSecret, runDailyOfdImport } from "@/lib/ofd/daily";
import { recordSecurityEvent } from "@/lib/security/security-event";

// Protected daily OFD auto-import for an external cron / systemd timer.
// POST /api/cron/ofd/daily with Authorization: Bearer <CRON_SECRET> (or
// X-Cron-Secret: <CRON_SECRET>). Imports YESTERDAY's Taxcom sales for every active
// connection and returns SAFE aggregates only — never login/password/Integrator-ID/
// Session-Token, raw Taxcom response, fiscal JSON, buyer PII or error stacks.
// Disabled feature or a missing CRON_SECRET → 503 (never runs); wrong secret → 401;
// non-POST → 405 (only POST is exported).
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = authorizeOfdCron({
    method: "POST",
    authorization: req.headers.get("authorization"),
    cronHeader: req.headers.get("x-cron-secret"),
    enabled: ofdEnabled(),
    secret: ofdCronSecret(),
  });
  if (!auth.ok) {
    // REM-07 — record the cron denial (never the secret or its hash). Best-effort.
    await recordSecurityEvent({
      eventType: "integration.cron_denied",
      severity: auth.status === 401 ? "high" : "warning",
      reasonCode: auth.status === 401 ? "invalid_secret" : "disabled_or_no_secret",
      route: "api:cron/ofd/daily",
      source: "cron",
      requestId: req.headers.get("x-request-id"),
      metadata: { method: "POST", outcome: String(auth.status) },
    });
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  }

  const result = await runDailyOfdImport();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
