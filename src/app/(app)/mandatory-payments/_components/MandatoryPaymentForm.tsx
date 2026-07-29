"use client";

import { useState } from "react";
import { DateField } from "@/components/mobile/DateField";
import { useFormState, useFormStatus } from "react-dom";
import { createOrUpdateMandatoryPayment } from "../actions";

type Option = { key: string; label: string };
type UserOption = { id: string; name: string };

export type EditingPlan = {
  id: string;
  clubId: string;
  category: string;
  title: string;
  amountRub: string;
  recurrence: string;
  dueDayOfMonth: number | null;
  dueDate: string; // YYYY-MM-DD or ""
  responsibleUserId: string;
  legalEntityId: string;
  notes: string;
};

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function Submit({ idle }: { idle: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "Сохранение..." : idle}
    </button>
  );
}

type EntityOption = { id: string; label: string };

export function MandatoryPaymentForm({
  clubs,
  categories,
  recurrences,
  users,
  entities,
  editing,
}: {
  clubs: Option[];
  categories: Option[];
  recurrences: Option[];
  users: UserOption[];
  entities: EntityOption[];
  editing?: EditingPlan;
}) {
  const [state, action] = useFormState(createOrUpdateMandatoryPayment, initial);
  const [recurrence, setRecurrence] = useState(editing?.recurrence ?? "monthly");
  const isEdit = Boolean(editing);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
        {isEdit ? "Изменить платёж" : "Добавить платёж"}
      </div>
      <form action={action} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {editing ? <input type="hidden" name="id" value={editing.id} /> : null}

        <Field label="Клуб">
          <select name="clubId" defaultValue={editing?.clubId ?? ""} required className="input">
            <option value="" disabled>Выберите</option>
            {clubs.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>

        <Field label="Категория">
          <select name="category" defaultValue={editing?.category ?? ""} required className="input">
            <option value="" disabled>Выберите</option>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>

        <Field label="Название">
          <input name="title" defaultValue={editing?.title ?? ""} required className="input" placeholder="Напр. Аренда зала" />
        </Field>

        <Field label="Сумма, ₽">
          <input name="amount" inputMode="decimal" defaultValue={editing?.amountRub ?? ""} required className="input" />
        </Field>

        <Field label="Повтор">
          <select name="recurrence" value={recurrence} onChange={(e) => setRecurrence(e.target.value)} className="input">
            {recurrences.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </Field>

        {recurrence === "monthly" ? (
          <Field label="День оплаты (1–31)">
            <input name="dueDayOfMonth" type="number" min={1} max={31} defaultValue={editing?.dueDayOfMonth ?? ""} className="input" />
          </Field>
        ) : (
          <Field label="Дата оплаты">
            <DateField name="dueDate" defaultValue={editing?.dueDate ?? ""} ariaLabel="Дата оплаты" />
          </Field>
        )}

        <Field label="Юрлицо (кто платит)">
          <select name="legalEntityId" defaultValue={editing?.legalEntityId ?? ""} className="input">
            <option value="">Не указано</option>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </Field>

        <Field label="Ответственный">
          <select name="responsibleUserId" defaultValue={editing?.responsibleUserId ?? ""} className="input">
            <option value="">Не назначен</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>

        <Field label="Заметки" className="sm:col-span-2 lg:col-span-2">
          <input name="notes" defaultValue={editing?.notes ?? ""} className="input" />
        </Field>

        <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-3">
          <Submit idle={isEdit ? "Сохранить" : "Добавить платёж"} />
          {state.ok ? (
            <span className="text-sm text-emerald-700 dark:text-emerald-400">Сохранено</span>
          ) : state.error ? (
            <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}
