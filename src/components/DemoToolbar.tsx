import type { NavItem } from "@/lib/navigation";
import { ROLE_LABELS } from "@/lib/navigation";

// Keep this strip compact: the full role/reset form belongs to /demo,
// and financial summaries belong to /dashboard. Mobile links are ordinary
// anchors so navigation still works in limited in-app browsers.
export function DemoToolbar({ role, items }: { role: string; items: ReadonlyArray<NavItem> }) {
  return (
    <aside
      aria-label="Демонстрационная версия"
      className="relative z-40 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] px-3 py-2 text-[var(--text-primary)] sm:px-5"
    >
      <div className="flex min-h-[40px] items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text-primary)] sm:text-sm" title="Демонстрационные данные · интеграции отключены">
          Демо · {ROLE_LABELS[role] ?? role}
        </span>
        <a
          href="/demo"
          className="inline-flex min-h-[40px] shrink-0 items-center rounded-md px-2 font-medium text-[var(--accent-primary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
        >
          Роль / сброс
        </a>
        <details className="relative shrink-0 lg:hidden">
          <summary className="flex min-h-[40px] cursor-pointer list-none items-center rounded-md border border-[var(--border-strong)] px-2 font-medium text-[var(--text-primary)]">
            Разделы <span aria-hidden="true" className="ml-1">⌄</span>
          </summary>
          <nav
            aria-label="Все разделы CLUB OPS"
            className="absolute right-0 top-full z-50 mt-2 max-h-[65dvh] w-[min(88vw,330px)] overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--surface-card)] p-2 shadow-xl"
          >
            {items.map((item) => (
              <a
                key={item.page}
                href={item.href}
                className="flex min-h-[44px] items-center rounded-md px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </details>
      </div>
    </aside>
  );
}
