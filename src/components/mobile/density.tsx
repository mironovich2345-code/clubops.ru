import type { ReactNode } from "react";
import { StatusBadge, type StatusTone } from "./StatusBadge";
import { InfoIcon } from "./icons";

// Shared mobile density system (spec §2/§17). One unified set — no near-duplicate
// components. Presentational (Server-Component-safe). Targets: page padding 16px,
// section gap 16px, compact card padding 12–14px, ≥44px targets, single card radius.

/** Compact page header: one H1 + short subtitle + optional action. Small top spacing,
 *  no oversized height (spec §3). */
export function CompactPageHeader({ title, subtitle, action, context }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; context?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="break-anywhere text-lg font-semibold leading-tight text-slate-900 sm:text-xl">{title}</h1>
        {subtitle ? <p className="mt-1 break-anywhere text-xs text-slate-500">{subtitle}</p> : null}
        {context ? <div className="mt-1 text-xs text-slate-400">{context}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Compact metric: label + primary value (+ optional status/secondary). Value stays on
 *  one line (₽ never wraps); long sums shrink via clamp but never go tiny (spec §7). */
export function CompactMetricCard({ label, value, tone, secondary }: { label: ReactNode; value: ReactNode; tone?: StatusTone; secondary?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="truncate text-xs text-slate-500">{label}</div>
      <div className="mt-1 whitespace-nowrap font-semibold tabular-nums text-slate-900" style={{ fontSize: "clamp(1.05rem, 5.5vw, 1.5rem)" }}>{value}</div>
      {tone || secondary ? (
        <div className="mt-1 flex items-center gap-2">
          {tone ? <StatusBadge tone={tone}>{secondary}</StatusBadge> : secondary ? <span className="text-xs text-slate-400">{secondary}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export type DataRow = { label: ReactNode; value: ReactNode; strong?: boolean; tone?: "muted" | "danger" | "success" };

const ROW_TONE: Record<string, string> = { muted: "text-slate-400", danger: "text-rose-700", success: "text-emerald-700" };

/** Summary card: a title + a compact definition list. For the OFD month summary and
 *  any "one entity, several numbers" block (spec §8). */
export function DataSummaryCard({ title, badge, rows }: { title: ReactNode; badge?: ReactNode; rows: DataRow[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 break-anywhere text-sm font-semibold text-slate-900">{title}</div>
        {badge ? <div className="shrink-0">{badge}</div> : null}
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="shrink-0 text-slate-500">{r.label}</dt>
            <dd className={`min-w-0 break-anywhere text-right tabular-nums ${r.strong ? "font-semibold text-slate-900" : ROW_TONE[r.tone ?? ""] ?? "text-slate-700"}`}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Generic mobile data card for a breakdown row (club / legal entity / budget line /
 *  history entry). Title + rows + optional badge + optional expandable details/footer.
 *  Replaces compressed desktop tables on mobile (spec §9/§13/§15/§18). */
export function MobileDataCard({ title, badge, rows = [], footer, details }: { title: ReactNode; badge?: ReactNode; rows?: DataRow[]; footer?: ReactNode; details?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 break-anywhere text-sm font-semibold text-slate-900">{title}</div>
        {badge ? <div className="shrink-0">{badge}</div> : null}
      </div>
      {rows.length > 0 ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
          {rows.map((r, i) => (
            <div key={i} className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
              <dt className="shrink-0 text-slate-500">{r.label}</dt>
              <dd className={`min-w-0 break-anywhere text-right tabular-nums ${r.strong ? "font-semibold text-slate-900" : ROW_TONE[r.tone ?? ""] ?? "text-slate-700"}`}>{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {details ? <details className="mt-2 text-xs"><summary className="cursor-pointer text-brand-700">Подробнее</summary><div className="mt-1">{details}</div></details> : null}
      {footer ? <div className="mt-2 border-t border-slate-100 pt-2">{footer}</div> : null}
    </div>
  );
}

/** Compact section title (spec §17). */
export function SectionHeader({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-4 flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-slate-700">{children}</h2>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Compact muted info note (e.g. permission hint) — never a full oversized card (§16). */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-inset ring-slate-200">
      <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 break-anywhere">{children}</span>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">{children}</div>;
}

/** Active-filter chips row (spec §4/§17). */
export function ActiveFilterChips({ chips }: { chips: { label: string }[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span key={i} className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">{c.label}</span>
      ))}
    </div>
  );
}
