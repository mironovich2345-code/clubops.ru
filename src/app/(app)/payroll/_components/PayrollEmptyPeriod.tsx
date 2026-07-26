"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { createPayrollPeriod, type PayrollPeriodFormState } from "../periods/actions";

const initial: PayrollPeriodFormState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand-600 px-5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Создание..." : "Создать период"}
    </button>
  );
}

/**
 * Compact empty state on the manager landing (spec §3): club + month + how many active
 * employees / without a scheme / with problems, and a single "Создать период" button that
 * creates the period for the CURRENT club+month and returns to the working screen (no trip
 * through the periods table).
 */
export function PayrollEmptyPeriod({
  clubName,
  clubId,
  month,
  monthTitle,
  activeEmployees,
  withoutScheme,
}: {
  clubName: string;
  clubId: string;
  month: string;
  monthTitle: string;
  activeEmployees: number;
  withoutScheme: number;
}) {
  const [state, action] = useFormState(createPayrollPeriod, initial);
  const router = useRouter();

  // On success return to the manager landing for this club+month — it now finds the period.
  useEffect(() => {
    if (state.ok && state.periodId) router.push(`/payroll?month=${month}&club=${clubId}`);
  }, [state.ok, state.periodId, month, clubId, router]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-base font-semibold text-slate-800 dark:text-slate-100">
        Расчётный период за {monthTitle} ещё не создан
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Клуб" value={clubName} />
        <Stat label="Месяц" value={monthTitle} />
        <Stat label="Активных сотрудников" value={String(activeEmployees)} />
        <Stat label="Без схемы / проблемы" value={String(withoutScheme)} accent={withoutScheme > 0} />
      </dl>
      {withoutScheme > 0 ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          У {withoutScheme} сотрудников не задана схема оплаты — их расчёты создадутся с предупреждением. Схемы настраивает региональный директор / бухгалтерия.
        </p>
      ) : null}
      <form action={action} className="mt-5 flex flex-wrap items-center gap-3">
        <input type="hidden" name="clubId" value={clubId} />
        <input type="hidden" name="month" value={month} />
        <Submit />
        {state.error ? <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span> : null}
      </form>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={`mt-0.5 text-sm font-semibold ${accent ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</dd>
    </div>
  );
}
