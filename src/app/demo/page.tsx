import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { assertDemoRequest, isDemo, DEMO_ROLES } from "@/lib/demo/config";
import { ROLE_LABELS } from "@/lib/navigation";

export const dynamic = "force-dynamic";

export default async function DemoPage() {
  if (!isDemo()) notFound();
  assertDemoRequest((await headers()).get("host"));

  const controlClass = "min-h-[48px] w-full min-w-0 rounded-lg border border-[var(--border-strong)] bg-[var(--input)] px-3 py-2 text-base font-medium text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]";
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-5 px-4 py-8 text-[var(--text-primary)] sm:px-6 sm:py-12">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-[var(--accent-primary)]">CLUB OPS · интерактивная демонстрация</p>
        <h1 className="text-2xl font-bold leading-tight text-[var(--text-primary)] sm:text-3xl">Управление сетью филиалов</h1>
        <p className="leading-6 text-[var(--text-secondary)]">
          Откройте оригинальное приложение на примере компании «Сфера»: три филиала, 48 вымышленных сотрудников, продажи, расходы, согласования, зарплаты и бюджеты.
        </p>
      </div>
      <section className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface-card)] p-4 shadow-sm sm:p-6" aria-labelledby="demo-start-title">
        <h2 id="demo-start-title" className="mb-1 text-xl font-semibold text-[var(--text-primary)]">Начать демонстрацию</h2>
        <p className="mb-5 text-sm leading-6 text-[var(--text-secondary)]">Выберите роль, чтобы увидеть доступные ей разделы и действия.</p>
        <form action="/api/demo/session" method="post" className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
            Роль
            <select name="role" defaultValue="owner" className={controlClass}>
              {DEMO_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
            Филиал управляющего
            <select name="club" defaultValue="0" className={controlClass}>
              <option value="0">Центральный</option>
              <option value="1">Северный</option>
              <option value="2">Южный</option>
            </select>
            <span className="text-xs font-normal leading-5 text-[var(--text-secondary)]">Влияет на доступ управляющего; собственнику доступны все филиалы.</span>
          </label>
          <button type="submit" className="min-h-[48px] rounded-lg bg-brand-600 px-5 py-3 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]">Посмотреть демо</button>
          <button type="submit" name="reset" value="1" className="min-h-[44px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-muted)] px-4 py-2 font-medium text-[var(--text-primary)]">
            Сбросить данные и начать заново
          </button>
        </form>
      </section>
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--accent-soft)] p-4 text-sm leading-6 text-[var(--text-primary)]">
        <p className="font-semibold">Демонстрационные данные · 1–15 ноября 2026</p>
        <p className="mt-1 text-[var(--text-secondary)]">
          Каждый посетитель получает отдельный набор данных на 2 часа. Изменения не затрагивают других посетителей. Почта, ОФД, ИИ, Telegram, внешние платежи и электронное подписание отключены.
        </p>
      </div>
    </main>
  );
}
