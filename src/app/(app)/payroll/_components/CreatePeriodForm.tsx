"use client";

import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { createPayrollPeriod, type PayrollPeriodFormState } from "../periods/actions";

const initial: PayrollPeriodFormState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Создание..." : "Создать период"}
    </button>
  );
}

export function CreatePeriodForm({ clubs }: { clubs: Array<{ id: string; name: string }> }) {
  const [state, action] = useFormState(createPayrollPeriod, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Клуб</span>
        <select name="clubId" defaultValue={clubs.length === 1 ? clubs[0]?.id : ""} required className="input">
          {clubs.length === 1 ? null : <option value="" disabled>Выберите</option>}
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {state.fieldErrors?.clubId ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.clubId}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Месяц</span>
        <input type="month" name="month" required className="input" />
        {state.fieldErrors?.month ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.month}</span> : null}
      </label>
      <Submit />
      {state.ok && state.periodId ? (
        <Link href={`/payroll/periods/${state.periodId}`} className="text-sm font-medium text-brand-600 hover:text-brand-700">
          Открыть период →
        </Link>
      ) : state.error ? (
        <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>
      ) : null}
    </form>
  );
}
