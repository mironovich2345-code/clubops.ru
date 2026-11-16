import { NextResponse, type NextRequest } from "next/server";
import { openDemoVisit } from "@/lib/demo/visits";
import { assertDemoRequest, isDemo } from "@/lib/demo/config";

export async function POST(request: NextRequest) {
  if (!isDemo()) return new NextResponse(null, { status: 404 });
  try {
    const config = assertDemoRequest(request.headers.get("host"), request.headers.get("origin"));
    // HTML forms and same-origin clients must provide Origin, never a cross-site bypass.
    if (request.headers.get("origin") !== config.origin) return new NextResponse("Доступ запрещён", { status: 403 });
    const form = await request.formData();
    const target = await openDemoVisit(String(form.get("role") ?? "owner"), Number(form.get("club") ?? "0"), form.get("reset") === "1");
    return NextResponse.redirect(new URL(target, config.origin), 303);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "DEMO_SELECTION_INVALID") return NextResponse.json({ error: "Выберите доступную роль и филиал." }, { status: 400 });
    if (code === "DEMO_ORIGIN_FORBIDDEN" || code === "DEMO_SESSION_MISMATCH") return NextResponse.json({ error: "Доступ запрещён." }, { status: 403 });
    if (code === "DEMO_CAPACITY_LIMIT") return NextResponse.json({ error: "Сейчас слишком много демосеансов. Повторите позже." }, { status: 429 });
    return NextResponse.json({ error: "Демосеанс временно недоступен." }, { status: 503 });
  }
}
