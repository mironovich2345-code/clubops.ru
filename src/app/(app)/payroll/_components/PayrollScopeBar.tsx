"use client";

import { useRouter } from "next/navigation";

// Compact month + club control for the manager landing (spec §4). ‹ prev · month · next ›
// + club select (only when several clubs). Mobile-first: ≥44px targets, no horizontal
// scroll, wraps on narrow screens. Changing the scope resets any group filter.
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthTitle(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
}

export function PayrollScopeBar({
  month,
  club,
  clubs,
}: {
  month: string;
  club: string;
  clubs: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const go = (next: { month?: string; club?: string }) => {
    const params = new URLSearchParams();
    params.set("month", next.month ?? month);
    params.set("club", next.club ?? club);
    router.push(`/payroll?${params.toString()}`);
  };

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <button
          type="button"
          aria-label="Предыдущий месяц"
          onClick={() => go({ month: shiftMonth(month, -1) })}
          className="flex h-11 w-11 items-center justify-center rounded-l-xl text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:hover:bg-slate-800"
        >
          ‹
        </button>
        {/* datefield-exempt: live month navigator (not a form field) */}
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && go({ month: e.target.value })}
          className="h-11 w-[10.5rem] border-x border-slate-200 bg-transparent px-2 text-center text-sm font-medium text-slate-800 focus:outline-none dark:border-slate-800 dark:text-slate-100"
          style={{ fontSize: 16 }}
          aria-label={`Месяц: ${monthTitle(month)}`}
        />
        <button
          type="button"
          aria-label="Следующий месяц"
          onClick={() => go({ month: shiftMonth(month, +1) })}
          className="flex h-11 w-11 items-center justify-center rounded-r-xl text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:hover:bg-slate-800"
        >
          ›
        </button>
      </div>

      {clubs.length > 1 ? (
        <select
          value={club}
          onChange={(e) => go({ club: e.target.value })}
          className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
          aria-label="Клуб"
        >
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
