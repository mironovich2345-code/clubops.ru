"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createOrUpdateBudget, requestBudgetApproval } from "../actions";

type CategoryOption = { key: string; label: string };

type BudgetState = { ok: boolean; error?: string };
type RequestState = { ok: boolean; error?: string; withinBudget?: boolean; created?: boolean };
const budgetInitial: BudgetState = { ok: false };
const requestInitial: RequestState = { ok: false };

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? busy : idle}
    </button>
  );
}

export function BudgetLimitForm({
  clubId,
  month,
  categories,
}: {
  clubId: string;
  month: string;
  categories: readonly CategoryOption[];
}) {
  const [state, action] = useFormState(createOrUpdateBudget, budgetInitial);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Установить лимит</div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="clubId" value={clubId} />
        <input type="hidden" name="month" value={month} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Статья</span>
          <select name="category" defaultValue="" required className="input">
            <option value="" disabled>Выберите</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Лимит, ₽</span>
          <input name="amount" inputMode="decimal" required className="input" />
        </label>
        <Submit idle="Сохранить лимит" busy="Сохранение..." />
        {state.ok ? (
          <span className="text-sm text-emerald-700">Лимит сохранён</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600">{state.error}</span>
        ) : null}
      </form>
    </div>
  );
}

export function RequestForm({
  clubId,
  month,
  categories,
}: {
  clubId: string;
  month: string;
  categories: readonly CategoryOption[];
}) {
  const [state, action] = useFormState(requestBudgetApproval, requestInitial);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Проверить операцию / запросить согласование</div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="clubId" value={clubId} />
        <input type="hidden" name="month" value={month} />
        <input type="hidden" name="sourceType" value="manual" />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Статья</span>
          <select name="category" defaultValue="" required className="input">
            <option value="" disabled>Выберите</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Сумма операции, ₽</span>
          <input name="amount" inputMode="decimal" required className="input" />
        </label>
        <Submit idle="Проверить" busy="Проверка..." />
        {state.ok && state.withinBudget ? (
          <span className="text-sm text-emerald-700">В пределах бюджета — согласование не требуется</span>
        ) : state.ok && state.created ? (
          <span className="text-sm text-amber-700">Перерасход — создан запрос на согласование</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600">{state.error}</span>
        ) : null}
      </form>
    </div>
  );
}
