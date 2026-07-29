"use client";

import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { createPayrollPeriod, type PayrollPeriodFormState } from "../periods/actions";
import { MonthField } from "@/components/mobile/DateField";
import { buttonClass } from "@/components/mobile/buttons";

const initial: PayrollPeriodFormState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant: "primary" })} w-full min-[380px]:col-span-2 lg:col-span-1 lg:w-auto`}>
      {pending ? "Создание..." : "Создать период"}
    </button>
  );
}

export function CreatePeriodForm({ clubs }: { clubs: Array<{ id: string; name: string }> }) {
  const [state, action] = useFormState(createPayrollPeriod, initial);
  return (
    // Mobile: 2-col grid; desktop: inline row. Full-width CTA on its own row on mobile.
    <form action={action} className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
      <label className="block min-w-0">
        <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Клуб</span>
        <select name="clubId" defaultValue={clubs.length === 1 ? clubs[0]?.id : ""} required className="input w-full">
          {clubs.length === 1 ? null : <option value="" disabled>Выберите</option>}
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {state.fieldErrors?.clubId ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.clubId}</span> : null}
      </label>
      <div className="min-w-0">
        <MonthField label="Месяц" name="month" required />
        {state.fieldErrors?.month ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.month}</span> : null}
      </div>
      <Submit />
      {state.ok && state.periodId ? (
        <Link href={`/payroll/periods/${state.periodId}`} className="text-sm font-medium text-brand-600 hover:text-brand-700 min-[380px]:col-span-2">
          Открыть период →
        </Link>
      ) : state.error ? (
        <span className="text-sm text-rose-600 dark:text-rose-400 min-[380px]:col-span-2">{state.error}</span>
      ) : null}
    </form>
  );
}
