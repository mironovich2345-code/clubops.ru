import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { assertDemoRequest, isDemo } from "@/lib/demo/config";
import { ROLE_LABELS } from "@/lib/navigation";
import { DEMO_ROLES } from "@/lib/demo/config";

export const dynamic = "force-dynamic";
export default async function DemoPage() {
  if (!isDemo()) notFound();
  assertDemoRequest((await headers()).get("host"));
  return <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-5 py-12">
    <p className="text-sm font-semibold text-brand-700">CLUB OPS · интерактивная демонстрация</p>
    <h1 className="text-3xl font-semibold">Операционное управление сетью филиалов</h1>
    <p>Исследуйте оригинальное приложение на примере компании «Сфера»: три филиала, 48 вымышленных сотрудников, продажи, расходы, согласования и бюджеты.</p>
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">Демонстрационная версия · вымышленные данные. История за 1–15 ноября 2026 года. Отдельные данные для каждого посетителя; сеанс действует 2 часа. Почта, ОФД, ИИ, Telegram и внешние платежи отключены.</div>
    <form action="/api/demo/session" method="post" className="grid gap-4 rounded-xl border bg-white p-5 shadow-sm">
      <label className="grid gap-2">Роль<select name="role" defaultValue="owner" className="rounded-md border p-3">{DEMO_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></label>
      <label className="grid gap-2">Филиал управляющего<select name="club" className="rounded-md border p-3"><option value="0">Центральный</option><option value="1">Северный</option><option value="2">Южный</option></select></label>
      <button className="rounded-lg bg-brand-600 px-5 py-3 font-semibold text-white">Посмотреть демо</button>
    </form>
    <p className="text-sm text-slate-500">Изменения остаются только в вашем тестовом наборе. Роль можно переключить; кнопка сброса создаёт новый набор данных. Банковские переводы и электронное подписание не выполняются.</p>
  </main>;
}
