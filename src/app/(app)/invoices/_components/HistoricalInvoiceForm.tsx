"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { saveHistoricalInvoice } from "../actions";

type State = { ok: boolean; error?: string; invoiceId?: string };
const initial: State = { ok: false };

type Entity = { id: string; name: string; type: string };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "Сохранение..." : "Добавить оплаченный счёт"}
    </button>
  );
}

/** Quick entry of a historical, already-paid invoice (imported past months).
 * Creates the invoice with status=paid — no approval workflow. */
export function HistoricalInvoiceForm({
  clubs,
  categories,
  legalEntitiesByClub,
  defaultClubId,
}: {
  clubs: Array<{ id: string; name: string }>;
  categories: ReadonlyArray<{ key: string; label: string }>;
  legalEntitiesByClub: Record<string, Entity[]>;
  defaultClubId: string;
}) {
  const [state, action] = useFormState(saveHistoricalInvoice, initial);
  const [clubId, setClubId] = useState(defaultClubId);
  const entities = legalEntitiesByClub[clubId] ?? [];

  return (
    <div className="mb-6 rounded-lg border border-emerald-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-slate-700">Добавить оплаченный счёт</div>
      <p className="mt-0.5 text-xs text-slate-500">Быстрый ввод исторических (уже оплаченных) счетов. Счёт сразу получает статус «Оплачено» и учитывается в расходах, бюджете и аналитике.</p>

      <form action={action} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Клуб</span>
          <select name="clubId" value={clubId} onChange={(e) => setClubId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm">
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Дата счёта</span>
          <input type="date" name="invoiceDate" required className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Дата оплаты</span>
          <input type="date" name="paidDate" required className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Сумма, ₽</span>
          <input name="amount" inputMode="decimal" placeholder="0" required className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Категория</span>
          <select name="expenseCategory" className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm">
            <option value="">— не выбрана —</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Юрлицо</span>
          <select name="legalEntityId" className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm">
            <option value="">— не выбрано —</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Поставщик (необязательно)</span>
          <input name="counterpartyName" className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Комментарий</span>
          <input name="comment" className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </label>
        <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
          <SaveButton />
          {state.ok ? (
            <span className="text-sm text-emerald-700">Оплаченный счёт добавлен.</span>
          ) : state.error ? (
            <span className="text-sm text-rose-600">{state.error}</span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
