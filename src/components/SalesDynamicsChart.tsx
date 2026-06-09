import { formatKopeks, formatKopeksShort } from "@/lib/money";
import type { SplitTrendBucket } from "@/lib/analytics";

/**
 * Sales dynamics chart: two grouped series per time bucket —
 * Абонементы (emerald) and Персональные тренировки (sky), matching the KPI card
 * accents. Server-rendered with plain divs (no chart library, no client JS).
 * Each bucket shows both bars side by side with a full-amount tooltip, the date
 * below and an optional weekday sub-label; sparse periods also get a compact
 * value label on top. Period totals are printed under the chart so the numbers
 * are always visible. Horizontally scrollable so bars stay readable; compact
 * empty state when there is no data.
 */
export function SalesDynamicsChart({ buckets, height = 200 }: { buckets: SplitTrendBucket[]; height?: number }) {
  const maxAbs = Math.max(...buckets.flatMap((b) => [b.subsKopeks, b.ptKopeks]), 0);
  if (buckets.length === 0 || maxAbs === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
        <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Нет данных за период</div>
        <div className="text-xs text-slate-400 dark:text-slate-500">Подтверждённых отчётов в выбранном периоде нет</div>
      </div>
    );
  }
  const showValues = buckets.length <= 14; // keep dense months uncluttered
  const subsTotal = buckets.reduce((sum, b) => sum + b.subsKopeks, 0);
  const ptTotal = buckets.reduce((sum, b) => sum + b.ptKopeks, 0);

  return (
    <div className="px-4 py-4">
      {/* Legend + axis max */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-5 text-xs font-medium text-slate-600 dark:text-slate-300">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />Абонементы</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-sky-500" />Персональные тренировки</span>
        </div>
        <span className="text-[11px] text-slate-400 dark:text-slate-500">макс: {formatKopeksShort(maxAbs)}</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex items-end gap-3" style={{ minWidth: buckets.length * 56 }}>
          {buckets.map((b, i) => {
            const subPx = Math.max(2, Math.round((Math.abs(b.subsKopeks) / maxAbs) * (height - 18)));
            const ptPx = Math.max(2, Math.round((Math.abs(b.ptKopeks) / maxAbs) * (height - 18)));
            return (
              <div key={i} className="flex flex-1 flex-col items-center">
                {showValues ? (
                  <div className="mb-0.5 w-full truncate text-center text-[9px] font-medium text-slate-400 dark:text-slate-500">
                    {b.subsKopeks + b.ptKopeks > 0 ? formatKopeksShort(b.subsKopeks + b.ptKopeks) : ""}
                  </div>
                ) : null}
                <div className="flex w-full items-end justify-center gap-1" style={{ height }}>
                  <div
                    className="w-1/2 max-w-[20px] rounded-t-sm bg-emerald-500"
                    style={{ height: subPx }}
                    title={`${b.label}: абонементы ${formatKopeks(b.subsKopeks)}`}
                  />
                  <div
                    className="w-1/2 max-w-[20px] rounded-t-sm bg-sky-500"
                    style={{ height: ptPx }}
                    title={`${b.label}: персональные ${formatKopeks(b.ptKopeks)}`}
                  />
                </div>
                <div className="mt-1.5 w-full truncate text-center text-[11px] font-medium text-slate-600 dark:text-slate-300">{b.label}</div>
                {b.subLabel ? <div className="w-full truncate text-center text-[10px] text-slate-400 dark:text-slate-500">{b.subLabel}</div> : null}
              </div>
            );
          })}
        </div>
      </div>
      {/* Period totals under the chart so the numbers are always visible */}
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <span>Абонементы за период: <span className="font-semibold text-emerald-600 dark:text-emerald-400">{formatKopeks(subsTotal)}</span></span>
        <span>Персональные за период: <span className="font-semibold text-sky-600 dark:text-sky-400">{formatKopeks(ptTotal)}</span></span>
      </div>
    </div>
  );
}
