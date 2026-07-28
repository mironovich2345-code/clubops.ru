import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { buttonClass } from "./buttons";

// Shared month navigator (Part 2 §3/§4). Symmetric 44×44 arrow buttons + a centered,
// truncating label; the "current month" badge/reset sits on its own line so a long
// month name never pushes the arrows around. Same look on 320–430px. Link-based so it
// works in server components (the page validates ?month and falls back).
export function MonthNav({
  prevHref,
  nextHref,
  label,
  badge,
}: {
  prevHref: string;
  nextHref: string | null; // null → next disabled (future month)
  label: ReactNode;
  badge?: ReactNode; // e.g. a "Текущий месяц" pill or reset link, centered below
}) {
  const arrow = `${buttonClass({ variant: "secondary", size: "md" })} h-11 w-11 shrink-0 px-0`;
  return (
    <div>
      <div className="flex items-center gap-2">
        <Link href={prevHref} aria-label="Предыдущий месяц" className={arrow}><ChevronLeftIcon className="h-5 w-5" /></Link>
        <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold capitalize text-slate-900 dark:text-slate-100">{label}</span>
        {nextHref ? (
          <Link href={nextHref} aria-label="Следующий месяц" className={arrow}><ChevronRightIcon className="h-5 w-5" /></Link>
        ) : (
          <span aria-label="Следующий месяц недоступен" className={`${arrow} opacity-40`}><ChevronRightIcon className="h-5 w-5" /></span>
        )}
      </div>
      {badge ? <div className="mt-2 flex justify-center">{badge}</div> : null}
    </div>
  );
}
