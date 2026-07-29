"use client";

import { useState } from "react";
import { MonthField } from "@/components/mobile/DateField";
import { useFormState, useFormStatus } from "react-dom";
import { recordEmployeeAdvance, type AdvanceState } from "../advance-actions";

const initial: AdvanceState = { ok: false };

export type AdvanceEmployeeOption = { id: string; fullName: string; clubId: string; clubName: string; position: string };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "…" : "Создать аванс"}
    </button>
  );
}

/**
 * Create an advance independently of a payroll period (§8/§10). Reuses the existing
 * recordEmployeeAdvance action, which links to a calc automatically if a period already
 * exists (findMonthCalc + recompute) and otherwise records a pre-period advance — no new
 * business logic, no double expense. Money/legal-entity are resolved server-side by role.
 */
export function AdvanceCreateForm({ employees, defaultMonth, canManage }: { employees: AdvanceEmployeeOption[]; defaultMonth: string; canManage: boolean }) {
  const [state, action] = useFormState(recordEmployeeAdvance, initial);
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const [open, setOpen] = useState(false);
  const emp = employees.find((e) => e.id === employeeId) ?? null;

  if (!canManage) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
        + Создать аванс
      </button>
    );
  }
  if (employees.length === 0) return <p className="text-sm text-slate-500">Нет сотрудников в зоне доступа.</p>;

  return (
    <form action={action} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Новый аванс</span>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-600">Свернуть</button>
      </div>
      <input type="hidden" name="clubId" value={emp?.clubId ?? ""} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Сотрудник</span>
          <select name="employeeId" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="input w-full">
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName} · {e.clubName}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Клуб</span>
          <input value={emp?.clubName ?? ""} disabled className="input w-full opacity-70" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Месяц аванса</span>
          <MonthField name="month" defaultValue={defaultMonth} ariaLabel="Месяц аванса" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Запрашиваемая сумма, ₽</span>
          <input name="amount" type="number" min="0" step="0.01" className="input w-full" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Способ выплаты</span>
          <select name="method" defaultValue="cash" className="input w-full">
            <option value="cash">Наличные</option>
            <option value="bank">Безнал</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Заработано к дате, ₽ (если расчёта нет)</span>
          <input name="earnedToDate" type="number" min="0" step="0.01" className="input w-full" placeholder="вручную" />
        </label>
        <label className="block sm:col-span-2 lg:col-span-3">
          <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Комментарий</span>
          <input name="comment" className="input w-full" placeholder="обязателен для ручной базы" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Submit />
        {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Аванс можно создать до расчётного периода. Если расчёт за месяц уже готов — сумма ограничена заработанным автоматически и аванс сразу привязывается к расчёту (без повторного расхода). Юрлицо и источник денег определяются по клубу и вашей роли. Наличный аванс проводит управляющий/регионал, безналичный — бухгалтер; ручная база управляющего требует подтверждения регионала.
      </p>
    </form>
  );
}
