"use client";

import { useFormState, useFormStatus } from "react-dom";
import { saveRegionalCityPayroll, recordRegionalCityPayment, type RegionalState } from "../regional/actions";

const initial: RegionalState = { ok: false };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "…" : label}
    </button>
  );
}

export function RegionalCreateForm({ cities, currentMonth }: { cities: string[]; currentMonth: string }) {
  const [state, action] = useFormState(saveRegionalCityPayroll, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Город</span>
        <select name="city" defaultValue={cities.length === 1 ? cities[0] : ""} required className="input w-full">
          {cities.length === 1 ? null : <option value="" disabled>Выберите</option>}
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Месяц</span>
        <input type="month" name="month" defaultValue={currentMonth} required className="input w-full" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">ФИО регионала</span>
        <input name="regionalName" required className="input w-full" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">База</span>
        <select name="baseType" defaultValue="revenue" className="input w-full">
          <option value="revenue">Выручка города</option>
          <option value="profit">Чистая прибыль города</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Сумма базы, ₽</span>
        <input name="base" type="number" min="0" step="0.01" required className="input w-full" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">Процент, %</span>
        <input name="percent" type="number" min="0" step="0.01" required className="input w-full" />
      </label>
      <div className="flex items-center gap-3 sm:col-span-3 lg:col-span-6">
        <Submit label="Сохранить (черновик)" />
        {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}

export function RegionalPaymentForm({ payrollId, clubs }: { payrollId: string; clubs: Array<{ id: string; name: string }> }) {
  const [state, action] = useFormState(recordRegionalCityPayment, initial);
  return (
    <form action={action} className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/40">
      <input type="hidden" name="regionalCityPayrollId" value={payrollId} />
      <label className="block">
        <span className="mb-1 block text-[11px] text-slate-500">Клуб-источник</span>
        <select name="clubId" defaultValue={clubs.length === 1 ? clubs[0]?.id : ""} required className="input text-sm">
          {clubs.length === 1 ? null : <option value="" disabled>Выберите</option>}
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] text-slate-500">Способ</span>
        <select name="method" defaultValue="cash" className="input text-sm">
          <option value="cash">Наличные</option>
          <option value="bank">Безнал</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] text-slate-500">Сумма, ₽</span>
        <input name="amount" type="number" min="0" step="0.01" className="input w-24 text-sm" />
      </label>
      <label className="flex items-center gap-1 pt-5 text-[11px] text-slate-600">
        <input type="checkbox" name="allowOverpayment" className="h-3.5 w-3.5" /> оформить переплату долгом
      </label>
      <Submit label="Выплатить из клуба" />
      {state.ok ? <span className="w-full text-xs text-emerald-600">{state.notice}</span> : state.error ? <span className="w-full text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}
