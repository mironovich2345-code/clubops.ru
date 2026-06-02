"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { SALE_SOURCES } from "@/lib/sales";
import { createSale, type CreateSaleState } from "../actions";

type ClubOption = { id: string; name: string; city: string };

const initialState: CreateSaleState = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Сохранить продажу"}
    </button>
  );
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function CreateSaleForm({ clubs }: { clubs: ClubOption[] }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(createSale, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setOpen(false);
    }
  }, [state]);

  const fe = state.fieldErrors ?? {};

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
        >
          {open ? "Скрыть форму" : "Добавить продажу"}
        </button>
      </div>

      {open ? (
        <form
          ref={formRef}
          action={formAction}
          className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Клуб" error={fe.clubId}>
              <select
                name="clubId"
                required
                defaultValue=""
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="" disabled>
                  Выберите клуб
                </option>
                {clubs.map((club) => (
                  <option key={club.id} value={club.id}>
                    {club.name} — {club.city}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Источник" error={fe.source}>
              <select
                name="source"
                required
                defaultValue=""
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="" disabled>
                  Выберите источник
                </option>
                {SALE_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Сумма, ₽" error={fe.amount}>
              <input
                name="amount"
                required
                inputMode="decimal"
                placeholder="0.00"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </Field>

            <Field label="Дата продажи" error={fe.saleDate}>
              <input
                type="date"
                name="saleDate"
                required
                defaultValue={todayIso()}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </Field>

            <div className="md:col-span-2">
              <Field label="Комментарий">
                <textarea
                  name="comment"
                  rows={2}
                  placeholder="Необязательно"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </Field>
            </div>
          </div>

          {state.error && !state.ok ? (
            <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {state.error}
            </div>
          ) : null}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Отмена
            </button>
            <SubmitButton />
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : null}
    </label>
  );
}
