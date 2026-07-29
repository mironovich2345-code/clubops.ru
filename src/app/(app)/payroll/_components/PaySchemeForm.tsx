"use client";

import { useState } from "react";
import { MonthField } from "@/components/mobile/DateField";
import { buttonClass } from "@/components/mobile/buttons";
import { useFormState, useFormStatus } from "react-dom";
import { savePayScheme, type PayrollFormState } from "../actions";
import { PAYROLL_SCHEME_LABELS } from "@/lib/payroll/enums";

const initial: PayrollFormState = { ok: false };

type Field = { name: string; label: string; placeholder?: string; step?: string };

// Field sets per scheme type — names MUST match collectSchemeRawParams in actions.ts.
const SCHEME_FIELDS: Record<string, Field[]> = {
  fixed_salary: [{ name: "baseRubles", label: "Оклад, ₽", placeholder: "30000" }],
  salary_by_shifts: [
    { name: "baseRubles", label: "Оклад (100%), ₽", placeholder: "30000" },
    { name: "shiftNorm", label: "Норматив смен", placeholder: "15" },
  ],
  salary_plus_percentage: [
    { name: "baseRubles", label: "Оклад (100%), ₽", placeholder: "30000" },
    { name: "shiftNorm", label: "Норматив смен", placeholder: "15" },
    { name: "belowPlanPercent", label: "% с продаж (план не выполнен)", placeholder: "3", step: "0.1" },
    { name: "atPlanPercent", label: "% с продаж (план выполнен)", placeholder: "4", step: "0.1" },
  ],
  sales_percentage: [{ name: "ratePercent", label: "% с продаж", placeholder: "5", step: "0.1" }],
  hourly: [{ name: "hourlyRateRubles", label: "Ставка за час/занятие, ₽", placeholder: "700" }],
  plan_adjusted_salary: [
    { name: "subscriptionsBaseRubles", label: "Окладная часть — абонементы, ₽", placeholder: "60000" },
    { name: "ptBaseRubles", label: "Окладная часть — ПТ, ₽", placeholder: "30000" },
    { name: "maxAdjustmentPercent", label: "Предел корректировки, %", placeholder: "40", step: "1" },
    { name: "manualReviewDeviationPercent", label: "Порог ручного решения, %", placeholder: "20", step: "1" },
  ],
  revenue_percentage: [
    { name: "fixedRubles", label: "Фиксированная часть, ₽", placeholder: "0" },
    { name: "subsPercent", label: "% с абонементов", placeholder: "0", step: "0.1" },
    { name: "ptPercent", label: "% с ПТ", placeholder: "0", step: "0.1" },
  ],
  profit_percentage: [{ name: "profitPercent", label: "% от прибыли", placeholder: "0", step: "0.1" }],
};

const SCHEME_ORDER = Object.keys(SCHEME_FIELDS);

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant: "primary", size: "cta" })} w-full sm:w-auto`}>
      {pending ? "Сохранение..." : "Сохранить схему"}
    </button>
  );
}

export function PaySchemeForm({
  employeeId,
  clubs,
  defaultClubId,
}: {
  employeeId: string;
  clubs: Array<{ id: string; name: string }>;
  defaultClubId: string;
}) {
  const [state, action] = useFormState(savePayScheme, initial);
  const [schemeType, setSchemeType] = useState<string>("fixed_salary");
  const fields = SCHEME_FIELDS[schemeType] ?? [];

  return (
    <form action={action} className="mt-2 space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <input type="hidden" name="employeeId" value={employeeId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Клуб</span>
          <select name="clubId" defaultValue={defaultClubId} required className="input w-full">
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Тип схемы</span>
          <select
            name="schemeType"
            value={schemeType}
            onChange={(e) => setSchemeType(e.target.value)}
            className="input w-full"
          >
            {SCHEME_ORDER.map((t) => <option key={t} value={t}>{PAYROLL_SCHEME_LABELS[t] ?? t}</option>)}
          </select>
          {state.fieldErrors?.schemeType ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.schemeType}</span> : null}
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Действует с месяца</span>
          <MonthField name="effectiveMonth" required ariaLabel="Действует с месяца" />
          {state.fieldErrors?.effectiveMonth ? <span className="mt-1 block text-xs text-rose-600">{state.fieldErrors.effectiveMonth}</span> : null}
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map((f) => (
          <label key={f.name} className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{f.label}</span>
            <input name={f.name} type="number" step={f.step ?? "1"} min="0" className="input w-full" placeholder={f.placeholder} />
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Submit />
        {state.ok ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">Схема сохранена</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>
        ) : null}
      </div>
      <p className="text-xs text-slate-400">
        Новая схема вступает в силу с начала выбранного месяца и не влияет на уже закрытые периоды. Предыдущая схема закрывается этой датой.
      </p>
    </form>
  );
}
