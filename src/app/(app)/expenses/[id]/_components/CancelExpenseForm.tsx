"use client";

import { useFormState, useFormStatus } from "react-dom";
import { cancelExpense } from "../../actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function CancelButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 shadow-sm hover:bg-rose-50 disabled:opacity-60"
    >
      {pending ? "Отмена..." : "Отменить расход"}
    </button>
  );
}

/** Cancel a single expense (with a confirmation prompt + optional reason). */
export function CancelExpenseForm({ expenseId }: { expenseId: string }) {
  const [state, action] = useFormState(cancelExpense, initial);
  if (state.ok) {
    return <p className="text-sm text-emerald-700">Расход отменён — он больше не учитывается в отчётах.</p>;
  }
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm("Вы уверены? Расход перестанет учитываться в отчётах.")) e.preventDefault();
      }}
      className="space-y-2"
    >
      <input type="hidden" name="expenseId" value={expenseId} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Причина (необязательно)</span>
        <input
          name="reason"
          placeholder="Например: ошибочный расход"
          className="w-full max-w-md rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <div className="flex items-center gap-3">
        <CancelButton />
        {state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}
