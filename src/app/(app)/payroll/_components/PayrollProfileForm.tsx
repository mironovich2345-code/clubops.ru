"use client";

import { useFormState, useFormStatus } from "react-dom";
import { DateField } from "@/components/mobile/DateField";
import { buttonClass } from "@/components/mobile/buttons";
import { updatePayrollProfile, type PayrollFormState } from "../actions";

const initial: PayrollFormState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant: "primary", size: "cta" })} w-full sm:w-auto`}>
      {pending ? "Сохранение..." : "Сохранить профиль"}
    </button>
  );
}

export function PayrollProfileForm({
  employeeId,
  initial: init,
  legalEntities,
}: {
  employeeId: string;
  initial: { hireDate: string; preferredPaymentMethod: string; isOfficial: boolean; defaultLegalEntityId: string };
  legalEntities: Array<{ id: string; name: string }>;
}) {
  const [state, action] = useFormState(updatePayrollProfile, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="employeeId" value={employeeId} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Дата приёма</span>
        <DateField name="hireDate" defaultValue={init.hireDate} ariaLabel="Дата приёма" />
        {state.fieldErrors?.hireDate ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.hireDate}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Способ выплаты</span>
        <select name="preferredPaymentMethod" defaultValue={init.preferredPaymentMethod} className="input w-full">
          <option value="">Не задан</option>
          <option value="cash">Наличные</option>
          <option value="bank">Безнал</option>
        </select>
        {state.fieldErrors?.preferredPaymentMethod ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.preferredPaymentMethod}</span> : null}
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Юрлицо по умолчанию</span>
        <select name="defaultLegalEntityId" defaultValue={init.defaultLegalEntityId} className="input w-full">
          <option value="">Не задано</option>
          {legalEntities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        {state.fieldErrors?.defaultLegalEntityId ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.defaultLegalEntityId}</span> : null}
      </label>
      <label className="flex items-center gap-2 pt-6">
        <input type="checkbox" name="isOfficial" defaultChecked={init.isOfficial} className="h-4 w-4 rounded border-slate-300" />
        <span className="text-sm text-slate-700 dark:text-slate-200">Официальное оформление</span>
      </label>
      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:gap-3 lg:col-span-4">
        <Submit />
        {state.ok ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">Сохранено</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}
