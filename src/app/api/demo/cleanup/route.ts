import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isDemo } from "@/lib/demo/config";
import { cleanupDemoVisits } from "@/lib/demo/visits";

export async function POST(request: NextRequest) {
  if (!isDemo()) return new NextResponse(null, { status: 404 });
  const key = process.env.DEMO_CLEANUP_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${key ?? ""}`;
  if (!key || key.length < 32 || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return new NextResponse(null, { status: 403 });
  return NextResponse.json({ removed: await cleanupDemoVisits() });
}
