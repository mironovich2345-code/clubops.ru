"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_SECTIONS } from "@/lib/navigation";
import { NavIcon, MenuIcon, CloseIcon, ChevronDownIcon } from "@/components/mobile/icons";

type Item = { page: string; href: string; label: string };

const OPEN_KEY = "clubops:mnav:open";

/**
 * Mobile app shell: a symmetric sticky top bar (44 / 1fr / 44) with a hamburger and a
 * slide-in drawer whose nav is GROUPED (NAV_SECTIONS) with collapsible, remembered groups
 * and a single SVG icon set. The current-account switcher sits at the top, company/club
 * context below. There is NO bottom navigation — the drawer is the sole mobile nav hub.
 * Rendered only below `lg` (desktop keeps the sidebar).
 */
export function MobileShell({ items, header, account }: { items: Item[]; header: React.ReactNode; account: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const byPage = new Map(items.map((i) => [i.page, i]));

  const activeGroupId = (NAV_SECTIONS.find((s) => s.type === "group" && s.pages.some((p) => { const it = byPage.get(p); return it && isActive(it.href); })) as { id: string } | undefined)?.id ?? null;

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

  const NavLink = ({ it, nested = false }: { it: Item; nested?: boolean }) => (
    <Link href={it.href} className={`flex min-h-[44px] min-w-0 items-center gap-3 rounded-md px-3 text-sm font-medium ${nested ? "pl-9" : ""} ${isActive(it.href) ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}>
      <NavIcon page={it.page} className={`h-5 w-5 shrink-0 ${nested ? "text-slate-400" : ""}`} />
      <span className="min-w-0 break-anywhere">{it.label}</span>
    </Link>
  );

  return (
    <>
      {/* Symmetric top bar: 44px menu / centered title / 44px spacer (§16) */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white pt-safe lg:hidden">
        <div className="grid h-12 grid-cols-[44px_1fr_44px] items-center px-2">
          <button type="button" aria-label="Меню" onClick={() => setOpen(true)} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100">
            <MenuIcon className="h-6 w-6" />
          </button>
          <span className="text-center text-sm font-semibold tracking-tight text-slate-900">CLUB<span className="text-brand-600">-OPS</span></span>
          <div aria-hidden />
        </div>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          {/* Bounded drawer: within viewport, no horizontal overflow, full-width children (§4) */}
          <div className="absolute inset-y-0 left-0 flex w-[min(88vw,360px)] max-w-full flex-col overflow-x-hidden bg-white pt-safe shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <span className="text-sm font-semibold text-slate-900">Меню</span>
              <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100">
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>
            {/* Current-account switcher (top) + company/club context (below) */}
            <div className="min-w-0 border-b border-slate-100 px-4 py-3">{account}</div>
            <div className="min-w-0 border-b border-slate-100 px-4 py-3">{header}</div>
            {/* Grouped, collapsible nav */}
            <nav className="min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-2 py-2 pb-safe">
              {NAV_SECTIONS.map((section) => {
                if (section.type === "item") {
                  const it = byPage.get(section.page);
                  return it ? <NavLink key={section.page} it={it} /> : null;
                }
                const children = section.pages.map((p) => byPage.get(p)).filter((x): x is Item => Boolean(x));
                if (children.length === 0) return null;
                const isOpen = openGroups[section.id] ?? false;
                return (
                  <div key={section.id} className="min-w-0">
                    <button type="button" onClick={() => toggleGroup(section.id)} className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100">
                      <span>{section.label}</span>
                      <ChevronDownIcon className={`h-4 w-4 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                    </button>
                    {isOpen ? <div className="mt-1 space-y-1">{children.map((it) => <NavLink key={it.page} it={it} nested />)}</div> : null}
                  </div>
                );
              })}
            </nav>
          </div>
        </div>
      ) : null}
    </>
  );
}
