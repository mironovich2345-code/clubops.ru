"use client";

import { useFormState, useFormStatus } from "react-dom";
import { saveSalesPlan } from "../actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Сохранить план"}
    </button>
  );
}

/** General-director-only inline form to set the current-month plan for the scope. */
export function SalesPlanForm({
  month,
  scopeLabel,
  currentTargetRubles,
}: {
  month: string;
  scopeLabel: string;
  currentTargetRubles: string;
}) {
  const [state, action] = useFormState(saveSalesPlan, initial);
  return (
    <form action={action} className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-200 pt-3">
      <input type="hidden" name="month" value={month} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">
          План продаж на месяц ({scopeLabel})
        </span>
        <input
          name="targetAmount"
          inputMode="decimal"
          defaultValue={currentTargetRubles}
          placeholder="0"
          className="w-40 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <SaveButton />
      {state.ok ? (
        <span className="text-sm text-emerald-700">Сохранено</span>
      ) : state.error ? (
        <span className="text-sm text-rose-600">{state.error}</span>
      ) : null}
    </form>
  );
}
