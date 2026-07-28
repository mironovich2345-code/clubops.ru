import type { ReactNode } from "react";

// Shared status badge for the finance contour (expenses / invoices / refunds). Replaces the
// per-page re-implementations (ExpenseStatusBadge, StatusBadge, …). Tone is semantic, not raw
// colour, and the label is ALWAYS text — never colour alone (spec §20, accessibility §24).
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE: Record<StatusTone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  info: "bg-sky-50 text-sky-700 ring-sky-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-rose-200",
};

export function StatusBadge({ tone = "neutral", children, className = "" }: { tone?: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[tone]} ${className}`}>
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Role/workflow note shown on detail pages (spec §20): current status + who must act next +
 * what happens after + why an action is blocked. Text-first, tone-coded. Never colour-only.
 */
export function StatusNote({ tone = "info", title, children }: { tone?: StatusTone; title: ReactNode; children?: ReactNode }) {
  const box: Record<StatusTone, string> = {
    neutral: "bg-slate-50 text-slate-700 ring-slate-200",
    info: "bg-sky-50 text-sky-800 ring-sky-200",
    success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    warning: "bg-amber-50 text-amber-900 ring-amber-200",
    danger: "bg-rose-50 text-rose-800 ring-rose-200",
  };
  return (
    <div role="status" className={`rounded-lg px-3 py-2 text-sm ring-1 ring-inset break-anywhere ${box[tone]}`}>
      <div className="font-medium">{title}</div>
      {children ? <div className="mt-0.5 text-xs opacity-90">{children}</div> : null}
    </div>
  );
}
