"use client";

import { useFormState, useFormStatus } from "react-dom";
import { saveSalesPlan } from "../actions";

type State = { ok: boolean; error?: string; saved?: number };
const initial: State = { ok: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : "Сохранить план"}
    </button>
  );
}

/**
 * General-director-only form to set the split sales plan (общий / абонементы /
 * персональные) for a club + month. Month is free (current / previous / любой).
 * An empty amount leaves that plan type unchanged; 0 saves an explicit zero.
 */
export function SalesPlanForm({
  clubs,
  defaultClubId,
  defaultMonth,
}: {
  clubs: Array<{ id: string; name: string }>;
  defaultClubId: string;
  defaultMonth: string;
}) {
  const [state, action] = useFormState(saveSalesPlan, initial);
  return (
    <form action={action} className="mt-3 space-y-3 border-t border-slate-200 pt-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Изменить план продаж</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Месяц</span>
          <input
            type="month"
            name="month"
            defaultValue={defaultMonth}
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Клуб</span>
          <select
            name="clubId"
            defaultValue={defaultClubId}
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <AmountField name="amount_total" label="Общий план" />
        <AmountField name="amount_subscriptions" label="План абонементы" />
        <AmountField name="amount_personal_training" label="План персональные тренировки" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SaveButton />
        <span className="text-xs text-slate-500">Пустое поле — не менять; 0 — сохранить ноль.</span>
        {state.ok ? (
          <span className="text-sm text-emerald-700">Сохранено ({state.saved})</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}

// Live thousands-grouping so the number of zeros is readable (2 500 000). The value
// is submitted with spaces; the server parser (parseImportAmountToKopeks) accepts them.
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function AmountField({ name, label }: { name: string; label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <input
        name={name}
        inputMode="numeric"
        placeholder="—"
        onInput={(e) => {
          const el = e.currentTarget;
          const digits = el.value.replace(/\D/g, "");
          el.value = digits ? groupThousands(digits) : "";
        }}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    </label>
  );
}
