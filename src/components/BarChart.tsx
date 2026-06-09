import { formatKopeks, formatKopeksShort } from "@/lib/money";

type Bar = { label: string; subLabel?: string; value: number };

const TONE: Record<string, { pos: string; neg: string }> = {
  brand: { pos: "bg-brand-500", neg: "bg-rose-500" },
  emerald: { pos: "bg-emerald-500", neg: "bg-rose-500" },
  rose: { pos: "bg-rose-500", neg: "bg-rose-500" },
  amber: { pos: "bg-amber-500", neg: "bg-rose-500" },
};

/**
 * Minimal vertical bar chart (kopeks). No external library. Each bar shows its
 * value label on top, a date label and (when provided) a weekday sub-label
 * below, and a full-amount tooltip. Supports negatives with a centered zero
 * baseline. Shows an empty state when there is no data — or when every value is
 * zero (no meaningless flat zero-line).
 */
export function BarChart({
  bars,
  tone = "brand",
  height = 160,
}: {
  bars: Bar[];
  tone?: keyof typeof TONE;
  height?: number;
}) {
  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.value)), 0);
  if (bars.length === 0 || maxAbs === 0) {
    return <div className="px-4 py-10 text-center text-sm text-slate-500">Нет данных за период</div>;
  }
  const colors = TONE[tone] ?? TONE.brand;
  const hasNeg = bars.some((b) => b.value < 0);
  const half = height / 2;

  return (
    <div className="overflow-x-auto px-4 py-4">
      <div className="flex min-w-full items-end gap-1.5" style={{ minWidth: bars.length * 40 }}>
        {bars.map((b, i) => {
          const frac = Math.abs(b.value) / maxAbs;
          const barPx = Math.max(2, Math.round(frac * (hasNeg ? half : height - 18)));
          const positive = b.value >= 0;
          return (
            <div
              key={i}
              className="flex flex-1 flex-col items-center"
              title={`${b.label}${b.subLabel ? " " + b.subLabel : ""}: ${formatKopeks(b.value)}`}
            >
              {/* Value label above the bar (compact). */}
              {!hasNeg ? (
                <div className="mb-0.5 w-full truncate text-center text-[9px] font-medium text-slate-500">
                  {b.value > 0 ? formatKopeksShort(b.value) : ""}
                </div>
              ) : null}
              <div className="relative w-full" style={{ height }}>
                {hasNeg ? (
                  <>
                    <div className="absolute inset-x-0 border-t border-dashed border-slate-200" style={{ top: half }} />
                    <div
                      className={`absolute inset-x-0 mx-auto w-4/5 rounded-sm ${positive ? colors.pos : colors.neg}`}
                      style={positive ? { bottom: half, height: barPx } : { top: half, height: barPx }}
                    />
                  </>
                ) : (
                  <div
                    className={`absolute inset-x-0 bottom-0 mx-auto w-4/5 rounded-sm ${colors.pos}`}
                    style={{ height: barPx }}
                  />
                )}
              </div>
              <div className="mt-1 w-full truncate text-center text-[10px] font-medium text-slate-500">{b.label}</div>
              {b.subLabel ? (
                <div className="w-full truncate text-center text-[10px] text-slate-400">{b.subLabel}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
