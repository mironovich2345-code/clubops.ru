"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { createSimplifiedExpenseDraft } from "../simplified-actions";

type Category = { key: string; name: string };
type Employee = { id: string; name: string };
type State = { ok: boolean; error?: string; expenseId?: string };
const initial: State = { ok: false };

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="w-full rounded-md bg-brand-600 px-4 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60">
      {pending ? "Создание…" : "Создать черновик"}
    </button>
  );
}

export function SimpleExpenseForm({ categories, employees }: { categories: Category[]; employees: Employee[] }) {
  const router = useRouter();
  const [state, action] = useFormState(async (prev: State | undefined, fd: FormData): Promise<State> => {
    const res = await createSimplifiedExpenseDraft(prev, fd);
    if (res.ok && res.expenseId) router.push(`/expenses/${res.expenseId}`);
    return res;
  }, initial);
  const [category, setCategory] = useState("");

  if (categories.length === 0) {
    return <div className="rounded-md bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">Нет активных статей расходов. Обратитесь к главному бухгалтеру.</div>;
  }

  return (
    <form action={action} className="mx-auto flex max-w-md flex-col gap-4">
      {/* Category name carried so the title is built from the human label. */}
      <input type="hidden" name="categoryName" value={categories.find((c) => c.key === category)?.name ?? ""} />

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Статья расходов</span>
        <select name="category" required value={category} onChange={(e) => setCategory(e.target.value)} className="input w-full">
          <option value="" disabled>Выберите статью</option>
          {categories.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Сумма, ₽</span>
        <input name="amount" required inputMode="decimal" placeholder="0,00" className="input w-full" />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Дата</span>
        <input type="date" name="expenseDate" required defaultValue={todayISO()} max={todayISO()} className="input w-full" />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Комментарий</span>
        <textarea name="comment" required rows={2} maxLength={2000} className="input w-full" />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Список покупок/оплат</span>
        <textarea name="shoppingList" required rows={3} maxLength={5000} className="input w-full" placeholder="Например: бумага, мыло, пакеты" />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Кто оплатил</span>
        <select name="paidByUserId" required defaultValue="" className="input w-full">
          <option value="" disabled>Выберите сотрудника</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </label>

      <p className="text-xs text-slate-500">Документы прикрепляются после создания черновика. Для отправки нужен минимум один документ.</p>
      <Submit />
      {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
    </form>
  );
}
