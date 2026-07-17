import { NextResponse } from "next/server";
import { ofdEnabled } from "@/lib/ofd/config";
import { authorizeOfdCron, ofdCronSecret, runDailyOfdImport } from "@/lib/ofd/daily";

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
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: { "Cache-Control": "no-store" } });
  }

  const result = await runDailyOfdImport();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
