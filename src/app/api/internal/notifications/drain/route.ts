import { NextResponse } from "next/server";
import { notificationDrainSecret } from "@/lib/telegram/config";
import { drainNotificationOutbox } from "@/lib/notifications/outbox";

export const dynamic = "force-dynamic";

// Protected drain endpoint for a cron / systemd timer. Requires
// `Authorization: Bearer <NOTIFICATION_DRAIN_SECRET>`. Returns COUNTS only — never
// notification text or chat ids. Without a configured secret it refuses access.
export async function POST(req: Request) {
  const secret = notificationDrainSecret();
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const counts = await drainNotificationOutbox(50);
  return NextResponse.json(counts, { headers: { "Cache-Control": "no-store" } });
}
