import { NextResponse } from "next/server";
import { notificationDrainSecret } from "@/lib/telegram/config";
import { bearerEquals } from "@/lib/secure-compare";
import { drainNotificationOutbox } from "@/lib/notifications/outbox";

export const dynamic = "force-dynamic";

// Protected drain endpoint for a cron / systemd timer. Requires
// `Authorization: Bearer <NOTIFICATION_DRAIN_SECRET>`. Returns COUNTS only — never
// notification text or chat ids. Without a configured secret it refuses access.
export async function POST(req: Request) {
  const secret = notificationDrainSecret();
  // Fail-closed + constant-time: a missing server secret or wrong Bearer → 401.
  if (!bearerEquals(req.headers.get("authorization"), secret)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const counts = await drainNotificationOutbox(50);
  return NextResponse.json(counts, { headers: { "Cache-Control": "no-store" } });
}
