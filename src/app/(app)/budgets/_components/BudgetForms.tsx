"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createOrUpdateBudget } from "../actions";
import { buttonClass } from "@/components/mobile/buttons";

type CategoryOption = { key: string; label: string };

type BudgetState = { ok: boolean; error?: string };
const budgetInitial: BudgetState = { ok: false };

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant: "primary", size: "cta" })} w-full`}>
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
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Установить лимит</div>
      {/* Mobile: Статья / Лимит / Сохранить each full-width, 12px gaps, equal heights. (spec §9) */}
      <form action={action} className="grid grid-cols-1 gap-3">
        <input type="hidden" name="clubId" value={clubId} />
        <input type="hidden" name="month" value={month} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Статья</span>
          <select name="category" defaultValue="" required className="input w-full">
            <option value="" disabled>Выберите</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Лимит, ₽</span>
          <input name="amount" inputMode="decimal" required className="input w-full" />
        </label>
        <Submit idle="Сохранить лимит" busy="Сохранение..." />
        {state.ok ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400">Лимит сохранён</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>
        ) : null}
      </form>
    </div>
  );
}
