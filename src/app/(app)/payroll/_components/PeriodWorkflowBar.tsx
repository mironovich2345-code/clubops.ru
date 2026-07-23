"use client";

import { useFormState, useFormStatus } from "react-dom";
import { transitionPeriod, type PayrollWorkflowState } from "../periods/actions";

const initial: PayrollWorkflowState = { ok: false };

function ActionButton({ action, label, tone }: { action: string; label: string; tone: "primary" | "neutral" | "danger" }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "primary"
      ? "bg-brand-600 text-white hover:bg-brand-700"
      : tone === "danger"
        ? "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300"
        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200";
  return (
    <button type="submit" name="action" value={action} disabled={pending} className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium shadow-sm disabled:opacity-60 ${cls}`}>
      {label}
    </button>
  );
}

export function PeriodWorkflowBar({
  periodId,
  actions,
}: {
  periodId: string;
  actions: Array<{ action: string; label: string }>;
}) {
  const [state, action] = useFormState(transitionPeriod, initial);
  if (actions.length === 0) return null;
  const tone = (a: string): "primary" | "neutral" | "danger" =>
    a === "return_for_correction" ? "danger" : a.includes("approve") || a === "close" || a === "mark_paid" ? "primary" : "neutral";
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="periodId" value={periodId} />
      <label className="block grow">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Комментарий (для возврата на исправление)</span>
        <input name="comment" className="input w-full" placeholder="Причина возврата / примечание" />
      </label>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => <ActionButton key={a.action} action={a.action} label={a.label} tone={tone(a.action)} />)}
      </div>
      {state.error ? <span className="w-full text-sm text-rose-600 dark:text-rose-400">{state.error}</span> : null}
    </form>
  );
}
