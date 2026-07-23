"use client";

import { useFormState, useFormStatus } from "react-dom";
import { saveClubAssignment, type PayrollFormState } from "../actions";
import { PAYROLL_POSITIONS, PAYROLL_POSITION_LABELS } from "@/lib/payroll/enums";

const initial: PayrollFormState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Добавить закрепление"}
    </button>
  );
}

export function AssignmentForm({ employeeId, clubs }: { employeeId: string; clubs: Array<{ id: string; name: string }> }) {
  const [state, action] = useFormState(saveClubAssignment, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="employeeId" value={employeeId} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Клуб</span>
        <select name="clubId" defaultValue={clubs.length === 1 ? clubs[0]?.id : ""} required className="input w-full">
          {clubs.length === 1 ? null : <option value="" disabled>Выберите</option>}
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Должность</span>
        <select name="position" defaultValue="" required className="input w-full">
          <option value="" disabled>Выберите</option>
          {PAYROLL_POSITIONS.map((p) => <option key={p} value={p}>{PAYROLL_POSITION_LABELS[p] ?? p}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Доля начисления, % (опц.)</span>
        <input name="earningSharePercent" type="number" min="0" max="100" step="1" className="input w-full" placeholder="100" />
      </label>
      <div className="flex items-end gap-3">
        <Submit />
      </div>
      {state.ok ? (
        <span className="text-sm text-emerald-700 dark:text-emerald-400 sm:col-span-2 lg:col-span-4">Закрепление сохранено</span>
      ) : state.error ? (
        <span className="text-sm text-rose-600 dark:text-rose-400 sm:col-span-2 lg:col-span-4">{state.error}</span>
      ) : null}
    </form>
  );
}
