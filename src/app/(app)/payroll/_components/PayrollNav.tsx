"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Horizontal sub-navigation for the payroll (ФОТ) module. Role-aware: a pure club
// manager (управляющий) sees ONE working screen + Долги; everyone else keeps the full
// toolbar. The mode is resolved server-side (payrollNavMode) and passed in.
type NavItem = { href: string; label: string; match: (p: string) => boolean };

const FULL_ITEMS: NavItem[] = [
  { href: "/payroll", label: "Обзор", match: (p) => p === "/payroll" },
  { href: "/payroll/employees", label: "Сотрудники и схемы", match: (p) => p.startsWith("/payroll/employees") },
  { href: "/payroll/periods", label: "Расчётные периоды", match: (p) => p.startsWith("/payroll/periods") },
  { href: "/payroll/advances", label: "Авансы", match: (p) => p.startsWith("/payroll/advances") },
  { href: "/payroll/payments", label: "Выплаты", match: (p) => p.startsWith("/payroll/payments") },
  { href: "/payroll/obligations", label: "Долги", match: (p) => p.startsWith("/payroll/obligations") || p.startsWith("/payroll/debts") },
  { href: "/payroll/change-requests", label: "Согласования", match: (p) => p.startsWith("/payroll/change-requests") },
  { href: "/payroll/regional", label: "Регионал", match: (p) => p.startsWith("/payroll/regional") },
];

// Manager: one working screen (Зарплата) + Долги. "Зарплата" стаётся активной на рабочем
// экране периода и в контекстных экранах (аванс, расчёт сотрудника).
const MANAGER_ITEMS: NavItem[] = [
  {
    href: "/payroll",
    label: "Зарплата",
    match: (p) =>
      p === "/payroll" ||
      p.startsWith("/payroll/periods") ||
      p.startsWith("/payroll/advances") ||
      p.startsWith("/payroll/change-requests"),
  },
  {
    href: "/payroll/debts",
    label: "Долги",
    match: (p) => p.startsWith("/payroll/debts") || p.startsWith("/payroll/obligations"),
  },
];

export function PayrollNav({ mode = "full" }: { mode?: "manager" | "full" }) {
  const pathname = usePathname() ?? "/payroll";
  const items = mode === "manager" ? MANAGER_ITEMS : FULL_ITEMS;

  // Manager: a compact 2-way segmented control (mobile-first, ≥44px targets, no 7-tab row).
  if (mode === "manager") {
    return (
      <nav className="mb-5">
        <ul className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800/70">
          {items.map((it) => {
            const active = it.match(pathname);
            return (
              <li key={it.href} className="flex-1">
                <Link
                  href={it.href}
                  className={`flex min-h-[44px] items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors ${
                    active
                      ? "bg-white text-brand-700 shadow-sm dark:bg-slate-900 dark:text-brand-300"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  {it.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav className="mb-5 -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-slate-200 px-1 dark:border-slate-800">
        {items.map((it) => {
          const active = it.match(pathname);
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                className={`inline-flex whitespace-nowrap rounded-t-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "border-b-2 border-brand-600 text-brand-700 dark:text-brand-300"
                    : "border-b-2 border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
