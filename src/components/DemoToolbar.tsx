import type { NavItem } from "@/lib/navigation";
import { DEMO_ROLES } from "@/lib/demo/config";
import { ROLE_LABELS } from "@/lib/navigation";

// Demo-only navigation fallback is plain HTML: works even if a mobile webview
// fails to hydrate the JavaScript drawer. Items are already permission-filtered
// by the server layout, so forbidden pages are never offered.
export function DemoToolbar({ role, items }: { role: string; items: ReadonlyArray<NavItem> }) {
  const fieldClass = "min-h-[44px] w-full min-w-0 rounded-md border border-[var(--border-strong)] bg-[var(--surface-card)] px-3 py-2 text-[var(--text-primary)]";
  const buttonClass = "min-h-[44px] rounded-md border border-[var(--border-strong)] bg-[var(--surface-muted)] px-3 py-2 font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]";
  const summaryClass = "flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 rounded-md border border-[var(--border-strong)] bg-[var(--surface-muted)] px-3 py-2 font-medium text-[var(--text-primary)]";
  return (
    <aside
      aria-label="Демонстрационная версия"
      className="border-b border-[var(--border-strong)] bg-[var(--surface-elevated)] px-4 py-3 text-sm text-[var(--text-primary)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-[var(--text-primary)]">Демоверсия CLUB OPS · вымышленные данные</p>
          <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">
            1–15 ноября 2026 · сеанс 2 часа · интеграции отключены
          </p>
        </div>
        <details className="w-full min-w-0 sm:w-auto sm:min-w-[270px]">
          <summary className={summaryClass}>
            <span>Сменить роль или сбросить данные</span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <form action="/api/demo/session" method="post" className="mt-2 grid gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 sm:min-w-[320px]">
            <label htmlFor="demo-role" className="text-xs font-medium text-[var(--text-secondary)]">Роль</label>
            <select id="demo-role" name="role" defaultValue={role} className={fieldClass}>
              {DEMO_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            <label htmlFor="demo-club" className="text-xs font-medium text-[var(--text-secondary)]">Филиал управляющего</label>
            <select id="demo-club" name="club" className={fieldClass}>
              <option value="0">Центральный</option>
              <option value="1">Северный</option>
              <option value="2">Южный</option>
            </select>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClass}>Сменить роль</button>
              <button type="submit" name="reset" value="1" className={buttonClass}>Сбросить демо</button>
            </div>
          </form>
        </details>
      </div>

      <details className="mt-3 lg:hidden">
        <summary className={summaryClass}>
          <span>Все разделы приложения</span>
          <span aria-hidden="true">⌄</span>
        </summary>
        <nav aria-label="Разделы CLUB OPS" className="mt-2 grid grid-cols-1 gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2 min-[400px]:grid-cols-2">
          {items.map((item) => (
            <a key={item.page} href={item.href} className="flex min-h-[44px] items-center rounded-md px-3 py-2 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-muted)]">
              {item.label}
            </a>
          ))}
        </nav>
      </details>

      <nav aria-label="Быстрые переходы" className="mt-2 hidden flex-wrap gap-4 lg:flex">
        <a className="font-medium text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]" href="/dashboard?month=2026-11">Дашборд</a>
        <a className="font-medium text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]" href="/employees">Сотрудники</a>
        {!["manager", "accountant"].includes(role) && (
          <a className="font-medium text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]" href="/demo/reconciliation">
            ОФД ↔ эквайринг ↔ CRM (синтетические данные)
          </a>
        )}
      </nav>
    </aside>
  );
}
