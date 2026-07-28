"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { page: string; href: string; label: string };

// Preferred order for the bottom bar's primary slots (financial contour first). Filtered to
// what the role can actually see, so no forbidden entries appear (spec §6/§25).
const PRIMARY_ORDER = ["workspace", "dashboard", "expenses", "invoices", "refunds", "collections", "payroll", "employees", "analytics"];
const SHORT: Record<string, string> = {
  workspace: "Стол", dashboard: "Главная", expenses: "Расходы", invoices: "Счета",
  refunds: "Возвраты", collections: "Наличные", payroll: "ФОТ", employees: "Кадры", analytics: "Аналитика",
};

/**
 * Mobile app shell (spec §6/§7): a sticky safe-area top bar with a hamburger, a slide-in
 * drawer holding the FULL role-filtered nav + scope switcher + account actions, and a fixed
 * bottom nav with ≤5 primary sections + «Ещё». Rendered only below `lg` — desktop keeps the
 * sidebar/header untouched.
 */
export function MobileShell({ items, header, account }: { items: Item[]; header: React.ReactNode; account: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);
  // Close the drawer on navigation.
  useEffect(() => { setOpen(false); }, [pathname]);

  const primary = PRIMARY_ORDER.map((p) => items.find((i) => i.page === p)).filter((x): x is Item => Boolean(x)).slice(0, 4);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <>
      {/* Sticky top bar (mobile only) */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white pt-safe lg:hidden">
        <div className="flex h-12 items-center justify-between px-3">
          <button type="button" aria-label="Меню" onClick={() => setOpen(true)} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100">
            <span className="text-xl leading-none">☰</span>
          </button>
          <span className="text-sm font-semibold tracking-tight text-slate-900">CLUB<span className="text-brand-600">-OPS</span></span>
          <div className="w-11" />
        </div>
      </header>

      {/* Drawer + backdrop */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[86%] max-w-xs flex-col bg-white pt-safe shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <span className="text-sm font-semibold text-slate-900">Меню</span>
              <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100">✕</button>
            </div>
            <div className="border-b border-slate-100 px-4 py-3">{header}</div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {items.map((it) => (
                <Link key={it.href} href={it.href} className={`block rounded-md px-3 py-2.5 text-sm font-medium ${isActive(it.href) ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}>
                  {it.label}
                </Link>
              ))}
            </nav>
            <div className="border-t border-slate-100 px-3 py-3 pb-safe">{account}</div>
          </div>
        </div>
      ) : null}

      {/* Fixed bottom nav (mobile only) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-safe lg:hidden">
        <ul className="flex items-stretch">
          {primary.map((it) => (
            <li key={it.href} className="flex-1">
              <Link href={it.href} className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium ${isActive(it.href) ? "text-brand-700" : "text-slate-500"}`}>
                <span className="truncate">{SHORT[it.page] ?? it.label}</span>
              </Link>
            </li>
          ))}
          <li className="flex-1">
            <button type="button" onClick={() => setOpen(true)} className="flex min-h-[52px] w-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium text-slate-500">
              <span>Ещё</span>
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}
