import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRightIcon, PaperclipIcon } from "./icons";

// Mobile list card for the finance contour. Rendered ONLY below `lg` (desktop keeps its
// <table>). Shows just what the audit's card spec lists: title/category, amount, key meta,
// status, who-must-act, documents flag, problem flag, and one primary affordance. Secondary
// technical fields belong on the detail page (spec §4/§8/§11, §14/§15).
export type CardMeta = { label: string; value: ReactNode };

export function MobileListCard({
  href,
  title,
  amount,
  status,
  meta = [],
  actor,
  hasDocs,
  problem,
  action,
}: {
  // Optional: when present the whole card links to the detail page; when absent (e.g. the
  // strategic "open" flow needs a form POST) the card is a plain container and navigation
  // lives in the `action` slot.
  href?: string;
  title: ReactNode;
  amount?: ReactNode;
  status?: ReactNode;
  meta?: CardMeta[];
  actor?: ReactNode;
  hasDocs?: boolean;
  problem?: ReactNode;
  action?: ReactNode;
}) {
  const Body = href
    ? ({ children }: { children: ReactNode }) => <Link href={href} className="block min-w-0">{children}</Link>
    : ({ children }: { children: ReactNode }) => <div className="block min-w-0">{children}</div>;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <Body>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="break-anywhere text-sm font-semibold text-slate-900">{title}</div>
          </div>
          {amount != null ? <div className="shrink-0 text-right text-base font-semibold text-slate-900">{amount}</div> : null}
        </div>

        {meta.length > 0 ? (
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-slate-500 sm:grid-cols-2">
            {meta.map((m, i) => (
              <div key={i} className="flex min-w-0 items-baseline gap-1">
                <dt className="shrink-0">{m.label}:</dt>
                <dd className="min-w-0 break-anywhere font-medium text-slate-700">{m.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {status}
          {actor ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
              <ArrowRightIcon className="h-3.5 w-3.5" />
              <span className="truncate">{actor}</span>
            </span>
          ) : null}
          {hasDocs ? <PaperclipIcon className="h-4 w-4 text-slate-400" aria-label="Есть документы" /> : null}
          {problem ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">{problem}</span>
          ) : null}
        </div>
      </Body>

      {action ? <div className="mt-3 border-t border-slate-100 pt-3">{action}</div> : null}
    </div>
  );
}
