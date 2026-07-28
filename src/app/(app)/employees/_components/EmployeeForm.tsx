"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createClubEmployee, type EmployeeFormState } from "../actions";
import { EMPLOYEE_POSITIONS } from "@/lib/club-employees";
import { buttonClass } from "@/components/mobile/buttons";

const initial: EmployeeFormState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant: "primary", size: "cta", block: true })} sm:w-auto`}>
      {pending ? "Сохранение..." : "Добавить сотрудника"}
    </button>
  );
}

export function EmployeeForm({ clubs }: { clubs: Array<{ id: string; name: string }> }) {
  const [state, action] = useFormState(createClubEmployee, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">ФИО</span>
        <input name="fullName" required className="input w-full" placeholder="Иванов Иван" />
        {state.fieldErrors?.fullName ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.fullName}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Должность</span>
        <select name="position" defaultValue="" required className="input w-full">
          <option value="" disabled>Выберите</option>
          {EMPLOYEE_POSITIONS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {state.fieldErrors?.position ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.position}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Клуб</span>
        <select name="clubId" defaultValue={clubs.length === 1 ? clubs[0]?.id : ""} required className="input w-full">
          {clubs.length === 1 ? null : <option value="" disabled>Выберите</option>}
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {state.fieldErrors?.clubId ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.clubId}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Комментарий</span>
        <input name="comment" className="input w-full" />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
        <Submit />
        {state.ok ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">Сотрудник добавлен</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}
