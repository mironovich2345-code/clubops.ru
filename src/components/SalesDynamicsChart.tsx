import { formatKopeks } from "@/lib/money";
import type { SplitTrendBucket } from "@/lib/analytics";

/**
 * Sales dynamics chart: two grouped series per time bucket —
 * Абонементы (emerald) and Персональные тренировки (indigo). Server-rendered
 * with plain divs (no chart library, no client JS). Each bucket shows both bars
 * side by side with a compact value label on top, the date below, an optional
 * weekday sub-label, and a full-amount tooltip. Horizontally scrollable so bars
 * stay readable; empty state when every value is zero.
 */
export function SalesDynamicsChart({ buckets, height = 200 }: { buckets: SplitTrendBucket[]; height?: number }) {
  const maxAbs = Math.max(...buckets.flatMap((b) => [b.subsKopeks, b.ptKopeks]), 0);
  if (buckets.length === 0 || maxAbs === 0) {
    return <div className="px-4 py-12 text-center text-sm text-slate-500">Нет данных за период</div>;
  }
  return (
    <div className="px-4 py-4">
      {/* Legend */}
      <div className="mb-3 flex items-center gap-5 text-xs font-medium text-slate-600">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />Абонементы</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-indigo-500" />Персональные тренировки</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex items-end gap-3" style={{ minWidth: buckets.length * 56 }}>
          {buckets.map((b, i) => {
            const subPx = Math.max(2, Math.round((Math.abs(b.subsKopeks) / maxAbs) * (height - 18)));
            const ptPx = Math.max(2, Math.round((Math.abs(b.ptKopeks) / maxAbs) * (height - 18)));
            return (
              <div key={i} className="flex flex-1 flex-col items-center">
                <div className="flex w-full items-end justify-center gap-1" style={{ height }}>
                  <div
                    className="w-1/2 max-w-[20px] rounded-t-sm bg-emerald-500"
                    style={{ height: subPx }}
                    title={`${b.label}: абонементы ${formatKopeks(b.subsKopeks)}`}
                  />
                  <div
                    className="w-1/2 max-w-[20px] rounded-t-sm bg-indigo-500"
                    style={{ height: ptPx }}
                    title={`${b.label}: персональные ${formatKopeks(b.ptKopeks)}`}
                  />
                </div>
                <div className="mt-1.5 w-full truncate text-center text-[11px] font-medium text-slate-600">{b.label}</div>
                {b.subLabel ? <div className="w-full truncate text-center text-[10px] text-slate-400">{b.subLabel}</div> : null}
              </div>
            );
          })}
        </div>
      </div>
      {/* Period totals under the chart so the numbers are always visible */}
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span>Абонементы за период: <span className="font-semibold text-emerald-700">{formatKopeks(buckets.reduce((s, b) => s + b.subsKopeks, 0))}</span></span>
        <span>Персональные за период: <span className="font-semibold text-indigo-700">{formatKopeks(buckets.reduce((s, b) => s + b.ptKopeks, 0))}</span></span>
      </div>
    </div>
  );
}
