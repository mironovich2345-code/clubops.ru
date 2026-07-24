"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { saveCalculationInputs, type PayrollPeriodFormState } from "../periods/actions";
import { formatKopeks } from "@/lib/money";

export type BreakdownLine = { label: string; valueKopeks?: number; text?: string };

type InputField = { name: string; label: string; kind: "int" | "rub" | "bool"; placeholder?: string };

// Field sets per scheme type — names MUST match collectPeriodInput in periods/actions.ts.
const INPUT_FIELDS: Record<string, InputField[]> = {
  fixed_salary: [],
  salary_by_shifts: [{ name: "actualShifts", label: "Отработано смен", kind: "int", placeholder: "15" }],
  salary_plus_percentage: [
    { name: "actualShifts", label: "Отработано смен", kind: "int", placeholder: "15" },
    { name: "netPersonalSales", label: "Личные продажи (чистые), ₽", kind: "rub" },
    { name: "planMet", label: "План продаж выполнен", kind: "bool" },
  ],
  sales_percentage: [{ name: "sales", label: "Продажи, ₽", kind: "rub" }],
  hourly: [{ name: "hours", label: "Часы (занятия)", kind: "int" }],
  plan_adjusted_salary: [
    { name: "subsPlan", label: "Абонементы — план, ₽", kind: "rub" },
    { name: "subsFact", label: "Абонементы — факт, ₽", kind: "rub" },
    { name: "ptPlan", label: "ПТ — план, ₽", kind: "rub" },
    { name: "ptFact", label: "ПТ — факт, ₽", kind: "rub" },
  ],
  revenue_percentage: [
    { name: "subsRevenue", label: "Выручка абонементы, ₽", kind: "rub" },
    { name: "ptRevenue", label: "Выручка ПТ, ₽", kind: "rub" },
  ],
  profit_percentage: [{ name: "cityProfit", label: "Прибыль города, ₽", kind: "rub" }],
  // The 70% payout gate (this month's sales-plan completion). Packages are entered below.
  gym_trainer: [{ name: "planCompletionPercent", label: "Выполнение плана продаж месяца, %", kind: "int" }],
  mixed: [{ name: "manualAmount", label: "Сумма (ручной ввод), ₽", kind: "rub" }],
};

const initialState: PayrollPeriodFormState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Расчёт..." : "Рассчитать"}
    </button>
  );
}

export function CalculationCard({
  calculationId,
  employeeName,
  roleLabel,
  schemeType,
  schemeLabel,
  status,
  automaticKopeks,
  grossKopeks,
  breakdown,
  warnings,
  locked,
  initial,
}: {
  calculationId: string;
  employeeName: string;
  roleLabel: string;
  schemeType: string | null;
  schemeLabel: string;
  status: string;
  automaticKopeks: number;
  grossKopeks: number;
  breakdown: BreakdownLine[];
  warnings: string[];
  locked: boolean;
  initial: Record<string, string>;
}) {
  const [state, action] = useFormState(saveCalculationInputs, initialState);
  const [open, setOpen] = useState(false);
  const fields = schemeType ? INPUT_FIELDS[schemeType] ?? [] : [];

  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{employeeName}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{roleLabel} · {schemeLabel}</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatKopeks(grossKopeks)}</div>
          {grossKopeks !== automaticKopeks ? (
            <div className="text-xs text-slate-400">авто {formatKopeks(automaticKopeks)}</div>
          ) : null}
          <div className="text-xs text-slate-400">{status}</div>
        </div>
      </div>

      {warnings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {warnings.map((w, i) => (
            <li key={i} className="text-xs text-amber-600 dark:text-amber-400">⚠ {w}</li>
          ))}
        </ul>
      ) : null}

      {breakdown.length > 0 ? (
        <div className="mt-2">
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400">
            {open ? "Скрыть расшифровку" : "Показать расшифровку"}
          </button>
          {open ? (
            <ul className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/40">
              {breakdown.map((b, i) => (
                <li key={i} className="flex justify-between gap-4 text-xs">
                  <span className="text-slate-600 dark:text-slate-300">{b.label}</span>
                  <span className="tabular-nums text-slate-800 dark:text-slate-100">
                    {b.valueKopeks != null ? formatKopeks(b.valueKopeks) : b.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {locked ? (
        <p className="mt-3 text-xs text-slate-400">Период закрыт для изменений — расчёт зафиксирован.</p>
      ) : schemeType == null ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">Схема оплаты не задана — задайте её в карточке сотрудника и обновите состав.</p>
      ) : fields.length === 0 ? (
        <form action={action} className="mt-3 flex items-center gap-3">
          <input type="hidden" name="calculationId" value={calculationId} />
          <Submit />
          {state.ok ? <span className="text-xs text-emerald-600">Рассчитано</span> : state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
        </form>
      ) : (
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="calculationId" value={calculationId} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map((f) =>
              f.kind === "bool" ? (
                <label key={f.name} className="flex items-center gap-2 pt-6">
                  <input type="checkbox" name={f.name} defaultChecked={initial[f.name] === "on"} className="h-4 w-4 rounded border-slate-300" />
                  <span className="text-sm text-slate-700 dark:text-slate-200">{f.label}</span>
                </label>
              ) : (
                <label key={f.name} className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{f.label}</span>
                  <input
                    name={f.name}
                    type="number"
                    step={f.kind === "int" ? "1" : "0.01"}
                    min="0"
                    defaultValue={initial[f.name] ?? ""}
                    placeholder={f.placeholder}
                    className="input w-full"
                  />
                </label>
              ),
            )}
          </div>
          <div className="flex items-center gap-3">
            <Submit />
            {state.ok ? <span className="text-xs text-emerald-600">Рассчитано</span> : state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
          </div>
        </form>
      )}
    </div>
  );
}
