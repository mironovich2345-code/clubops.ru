"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createBalanceSnapshot } from "../actions";

type TargetOption = { value: string; label: string };

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "Сохранение..." : "Сохранить остаток"}
    </button>
  );
}

export function BalanceForm({ targets, today }: { targets: TargetOption[]; today: string }) {
  const [state, action] = useFormState(createBalanceSnapshot, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Юрлицо</span>
        <select name="target" defaultValue="" required className="input">
          <option value="" disabled>Выберите</option>
          {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Дата</span>
        <input type="date" name="date" defaultValue={today} className="input" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Остаток, ₽</span>
        <input name="amount" inputMode="decimal" min={0} required className="input" placeholder="0" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Комментарий</span>
        <input name="comment" className="input" />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
        <Submit />
        {state.ok ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">Остаток сохранён</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}
