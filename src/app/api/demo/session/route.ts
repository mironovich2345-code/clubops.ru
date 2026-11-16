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
  } catch {
    return NextResponse.json({ error: "Демосеанс недоступен. Проверьте выбор роли или повторите позже: число сеансов ограничено." }, { status: 429 });
  }
}
