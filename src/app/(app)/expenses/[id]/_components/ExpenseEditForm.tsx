"use client";

import { useFormState, useFormStatus } from "react-dom";
import { updateExpense } from "../../actions";

type ExpenseView = {
  id: string;
  type: string;
  category: string;
  vendorName: string;
  recipientName: string;
  transferComment: string;
  amount: string;
  currency: string;
  purchaseDate: string;
  address: string;
  items: string;
  notes: string;
  clubName: string;
  hasFile: boolean;
  originalFileName: string;
};

type CategoryOption = { key: string; label: string };
type SaveState = { ok: boolean; error?: string; expenseId?: string };
const saveInitial: SaveState = { ok: false };

const TYPE_OPTIONS = [
  { value: "receipt", label: "Чек" },
  { value: "transfer", label: "Перевод" },
  { value: "manual", label: "Вручную" },
  { value: "payroll_statement", label: "Зарплатная ведомость" },
];

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Сохранить изменения"}
    </button>
  );
}

export function ExpenseEditForm({
  expense,
  categories,
}: {
  expense: ExpenseView;
  categories: readonly CategoryOption[];
}) {
  const [saved, saveAction] = useFormState(updateExpense, saveInitial);

  return (
    <div className="space-y-6">
      {expense.hasFile ? (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <a
            href={`/api/expenses/${expense.id}/file`}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            Открыть исходный файл{expense.originalFileName ? ` (${expense.originalFileName})` : ""}
          </a>
        </div>
      ) : null}

      <form action={saveAction} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <input type="hidden" name="expenseId" value={expense.id} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Тип">
            <select name="type" defaultValue={expense.type} className="input">
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Статья расходов">
            <select name="category" defaultValue={expense.category} className="input">
              <option value="" disabled>
                Выберите статью
              </option>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Магазин">
            <input name="vendorName" defaultValue={expense.vendorName} className="input" />
          </Field>
          <Field label="Получатель перевода">
            <input name="recipientName" defaultValue={expense.recipientName} className="input" />
          </Field>
          <div className="md:col-span-2">
            <Field label="Комментарий перевода">
              <input name="transferComment" defaultValue={expense.transferComment} className="input" />
            </Field>
          </div>
          <Field label="Сумма, ₽">
            <input name="amount" inputMode="decimal" defaultValue={expense.amount} className="input" />
          </Field>
          <Field label="Валюта">
            <input name="currency" defaultValue={expense.currency} className="input" />
          </Field>
          <Field label="Дата покупки">
            <input type="date" name="purchaseDate" defaultValue={expense.purchaseDate} className="input" />
          </Field>
          <Field label="Адрес">
            <input name="address" defaultValue={expense.address} className="input" />
          </Field>
          <div className="md:col-span-2">
            <Field label="Список покупок (по строке на позицию)">
              <textarea name="items" rows={3} defaultValue={expense.items} className="input" />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Примечания">
              <textarea name="notes" rows={2} defaultValue={expense.notes} className="input" />
            </Field>
          </div>
        </div>

        {saved.ok ? (
          <div className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
            Изменения сохранены.
          </div>
        ) : saved.error ? (
          <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
            {saved.error}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end">
          <SaveButton />
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
