"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_SECTIONS, NAV_ICONS } from "@/lib/navigation";

type Item = { page: string; href: string; label: string };

const SHORT: Record<string, string> = {
  workspace: "Стол", dashboard: "Главная", expenses: "Расходы", invoices: "Счета",
  refunds: "Возвраты", collections: "Наличные", payroll: "ФОТ", employees: "Кадры",
  analytics: "Аналитика", ofd_sales: "Продажи", payments: "Платежи", budgets: "Бюджеты",
};
const OPEN_KEY = "clubops:mnav:open";

/**
 * Mobile app shell (spec §11/§12/§15). Sticky safe-area top bar + a slide-in drawer
 * whose nav is GROUPED (NAV_SECTIONS) with collapsible, remembered groups and icons —
 * not a flat copy of the desktop sidebar. The current-account switcher sits at the top,
 * the company/club context just below. A role-aware bottom nav (order from
 * `bottomOrder`) shows ≤4 primary sections + «Ещё». Rendered only below `lg`.
 */
export function MobileShell({ items, header, account, bottomOrder }: { items: Item[]; header: React.ReactNode; account: React.ReactNode; bottomOrder: string[] }) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const byPage = new Map(items.map((i) => [i.page, i]));

  // Which group contains the active page (kept open by default).
  const activeGroupId = NAV_SECTIONS.find((s) => s.type === "group" && s.pages.some((p) => { const it = byPage.get(p); return it && isActive(it.href); }))?.type === "group"
    ? (NAV_SECTIONS.find((s) => s.type === "group" && s.pages.some((p) => { const it = byPage.get(p); return it && isActive(it.href); })) as { id: string }).id
    : null;

  useEffect(() => {
    let stored: Record<string, boolean> = {};
    try { stored = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}"); } catch { stored = {}; }
    if (activeGroupId) stored[activeGroupId] = true;
    setOpenGroups(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupId]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; return () => { document.body.style.overflow = ""; }; }, [open]);
  useEffect(() => { setOpen(false); }, [pathname]);

  const primary = bottomOrder.map((p) => byPage.get(p)).filter((x): x is Item => Boolean(x)).slice(0, 4);

  const NavLink = ({ it, nested = false }: { it: Item; nested?: boolean }) => (
    <Link href={it.href} className={`flex min-h-[44px] items-center gap-3 rounded-md px-3 text-sm font-medium ${nested ? "pl-9" : ""} ${isActive(it.href) ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}>
      {!nested ? <span className="w-5 shrink-0 text-center" aria-hidden>{NAV_ICONS[it.page] ?? "•"}</span> : <span className="w-5 shrink-0 text-center text-slate-400" aria-hidden>{NAV_ICONS[it.page] ?? "·"}</span>}
      <span className="min-w-0 break-anywhere">{it.label}</span>
    </Link>
  );

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white pt-safe lg:hidden">
        <div className="flex h-12 items-center justify-between px-3">
          <button type="button" aria-label="Меню" onClick={() => setOpen(true)} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100">
            <span className="text-xl leading-none">☰</span>
          </button>
          <span className="text-sm font-semibold tracking-tight text-slate-900">CLUB<span className="text-brand-600">-OPS</span></span>
          <div className="w-11" />
        </div>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[86%] max-w-xs flex-col bg-white pt-safe shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <span className="text-sm font-semibold text-slate-900">Меню</span>
              <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100">✕</button>
            </div>
            {/* Current-account switcher (top, §11) + company/club context (below) */}
            <div className="border-b border-slate-100 px-3 py-3">{account}</div>
            <div className="border-b border-slate-100 px-4 py-3">{header}</div>
            {/* Grouped, collapsible nav (§12) */}
            <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2">
              {NAV_SECTIONS.map((section, i) => {
                if (section.type === "item") {
                  const it = byPage.get(section.page);
                  return it ? <NavLink key={section.page} it={it} /> : null;
                }
                const children = section.pages.map((p) => byPage.get(p)).filter((x): x is Item => Boolean(x));
                if (children.length === 0) return null;
                const isOpen = openGroups[section.id] ?? false;
                return (
                  <div key={section.id}>
                    <button type="button" onClick={() => toggleGroup(section.id)} className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100">
                      <span>{section.label}</span>
                      <span className={`text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden>⌄</span>
                    </button>
                    {isOpen ? <div className="mt-1 space-y-1">{children.map((it) => <NavLink key={it.page} it={it} nested />)}</div> : null}
                  </div>
                );
              })}
            </nav>
          </div>
        </div>
      ) : null}

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-safe lg:hidden">
        <ul className="flex items-stretch">
          {primary.map((it) => (
            <li key={it.href} className="flex-1">
              <Link href={it.href} className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium ${isActive(it.href) ? "text-brand-700" : "text-slate-500"}`}>
                <span className="text-base leading-none" aria-hidden>{NAV_ICONS[it.page] ?? "•"}</span>
                <span className="truncate">{SHORT[it.page] ?? it.label}</span>
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <button type="button" onClick={() => setOpen(true)} className="flex min-h-[52px] w-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium text-slate-500">
              <span className="text-base leading-none" aria-hidden>☰</span>
              <span>Ещё</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}
