import { formatKopeks } from "@/lib/money";

type Bar = { label: string; value: number };

const TONE: Record<string, { pos: string; neg: string }> = {
  brand: { pos: "bg-brand-500", neg: "bg-rose-500" },
  emerald: { pos: "bg-emerald-500", neg: "bg-rose-500" },
  rose: { pos: "bg-rose-500", neg: "bg-rose-500" },
  amber: { pos: "bg-amber-500", neg: "bg-rose-500" },
};

/**
 * Minimal vertical bar chart (kopeks). Dashboard style, no external library.
 * Supports negative values (e.g. profit) with a centered zero baseline.
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
  if (bars.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-slate-500">Нет данных за период.</div>;
  }
  const colors = TONE[tone] ?? TONE.brand;
  const maxAbs = Math.max(1, ...bars.map((b) => Math.abs(b.value)));
  const hasNeg = bars.some((b) => b.value < 0);
  const half = height / 2;

  return (
    <div className="overflow-x-auto px-4 py-4">
      <div className="flex min-w-full items-end gap-1.5" style={{ minWidth: bars.length * 28 }}>
        {bars.map((b, i) => {
          const frac = Math.abs(b.value) / maxAbs;
          const barPx = Math.max(2, Math.round(frac * (hasNeg ? half : height)));
          const positive = b.value >= 0;
          return (
            <div key={i} className="flex flex-1 flex-col items-center" title={`${b.label}: ${formatKopeks(b.value)}`}>
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
              <div className="mt-1 w-full truncate text-center text-[10px] text-slate-400">{b.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
