import { DEMO_ROLES } from "@/lib/demo/config";
import { ROLE_LABELS } from "@/lib/navigation";

export function DemoToolbar({ role }: { role: string }) {
  return <aside className="border-b border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" aria-label="Демонстрационная версия">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><strong>Демонстрационная версия · вымышленные данные</strong><p className="text-xs">1–15 ноября 2026 · 2 часа на сеанс · интеграции отключены</p></div>
      <form action="/api/demo/session" method="post" className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="demo-role">Демонстрационная роль</label>
        <select id="demo-role" name="role" defaultValue={role} className="max-w-full rounded border bg-white p-2">{DEMO_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
        <label className="sr-only" htmlFor="demo-club">Филиал управляющего</label>
        <select id="demo-club" name="club" className="rounded border bg-white p-2"><option value="0">Центральный</option><option value="1">Северный</option><option value="2">Южный</option></select>
        <button className="rounded border bg-white p-2">Сменить роль</button>
        <button name="reset" value="1" className="rounded border border-amber-400 bg-white p-2">Сбросить демо</button>
      </form>
    </div>
    <nav className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{role !== "accountant" && <a className="underline" href="/dashboard?month=2026-11">Дашборд</a>}<a className="underline" href="/employees">Сотрудники</a>{!["manager", "accountant"].includes(role) && <a className="underline" href="/demo/reconciliation">ОФД ↔ эквайринг ↔ CRM (синтетическое дополнение)</a>}</nav>
  </aside>;
}
