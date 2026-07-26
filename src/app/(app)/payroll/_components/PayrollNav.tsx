"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Horizontal sub-navigation for the payroll (ФОТ) module. One place to switch between
// the stages of the process instead of scattering functions across one screen.
const ITEMS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: "/payroll", label: "Обзор", match: (p) => p === "/payroll" },
  { href: "/payroll/employees", label: "Сотрудники и схемы", match: (p) => p.startsWith("/payroll/employees") },
  { href: "/payroll/periods", label: "Расчётные периоды", match: (p) => p.startsWith("/payroll/periods") },
  { href: "/payroll/advances", label: "Авансы", match: (p) => p.startsWith("/payroll/advances") },
  { href: "/payroll/payments", label: "Выплаты", match: (p) => p.startsWith("/payroll/payments") },
  { href: "/payroll/obligations", label: "Долги", match: (p) => p.startsWith("/payroll/obligations") },
  { href: "/payroll/regional", label: "Регионал", match: (p) => p.startsWith("/payroll/regional") },
];

export function PayrollNav() {
  const pathname = usePathname() ?? "/payroll";
  return (
    <nav className="mb-5 -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-slate-200 px-1 dark:border-slate-800">
        {ITEMS.map((it) => {
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
