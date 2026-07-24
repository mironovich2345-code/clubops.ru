"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { submitDailyCashReconciliation, type ReconState } from "../reconciliation-actions";
import { formatKopeks } from "@/lib/money";

// Duplicated here (not imported from the server lib) to keep prisma out of the client bundle.
const REASONS: Array<{ code: string; label: string }> = [
  { code: "receipt_no_cash", label: "Чек пробит, деньги не получены" },
  { code: "wrong_payment_method", label: "Неверный способ оплаты" },
  { code: "wrong_legal_entity", label: "Неверное юрлицо" },
  { code: "unrecorded_expense", label: "Неучтённый расход" },
  { code: "unrecorded_deposit", label: "Неучтённое внесение" },
  { code: "money_in_transit", label: "Деньги в пути" },
  { code: "shortage", label: "Недостача" },
  { code: "surplus", label: "Излишек" },
  { code: "prior_day_error", label: "Ошибка прошлого дня" },
  { code: "other", label: "Другое" },
];

const initial: ReconState = { ok: false };

export type ReconEntity = {
  legalEntityType: "ooo" | "ip";
  name: string;
  ofdCashRevenueKopeks: number;
  expectedCashBalanceKopeks: number;
  actualKopeks: number | null; // existing submitted value, if any
  status: string | null;
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "Сохранение..." : "Подтвердить наличные"}
    </button>
  );
}

function EntityRow({ e }: { e: ReconEntity }) {
  const [actual, setActual] = useState<string>(e.actualKopeks != null ? String(e.actualKopeks / 100) : "");
  const parsed = actual.trim() === "" ? null : Number(actual.replace(",", "."));
  const actualKopeks = parsed != null && Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : null;
  const diff = actualKopeks == null ? null : actualKopeks - e.expectedCashBalanceKopeks;
  const hasDiff = diff != null && diff !== 0;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="mb-2 text-sm font-semibold text-slate-700">{e.name} ({e.legalEntityType.toUpperCase()})</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="По ОФД наличными"><span className="tabular-nums text-slate-700">{formatKopeks(e.ofdCashRevenueKopeks)}</span></Field>
        <Field label="Ожидаемый остаток"><span className="tabular-nums text-slate-700">{formatKopeks(e.expectedCashBalanceKopeks)}</span></Field>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Фактически пересчитано, ₽</span>
          <input
            name={`${e.legalEntityType}_actual`}
            type="number"
            min="0"
            step="0.01"
            value={actual}
            onChange={(ev) => setActual(ev.target.value)}
            className="input w-full"
            placeholder="0"
          />
        </label>
        <Field label="Расхождение">
          <span className={`tabular-nums font-semibold ${hasDiff ? "text-rose-600" : "text-emerald-600"}`}>
            {diff == null ? "—" : formatKopeks(diff)}
          </span>
        </Field>
      </div>
      {hasDiff ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Причина расхождения</span>
            <select name={`${e.legalEntityType}_reason`} defaultValue="" required className="input w-full">
              <option value="" disabled>Выберите</option>
              {REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Комментарий (обязательно)</span>
            <input name={`${e.legalEntityType}_comment`} required className="input w-full" />
          </label>
        </div>
      ) : (
        <input type="hidden" name={`${e.legalEntityType}_comment`} value="" />
      )}
    </div>
  );
}

export function ReconciliationForm({
  clubId,
  businessDateLabel,
  entities,
}: {
  clubId: string;
  businessDateLabel: string;
  entities: ReconEntity[];
}) {
  const [state, action] = useFormState(submitDailyCashReconciliation, initial);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="clubId" value={clubId} />
      <div className="text-sm text-slate-600">Подтвердите фактические деньги за <span className="font-semibold">{businessDateLabel}</span></div>
      {entities.map((e) => <EntityRow key={e.legalEntityType} e={e} />)}
      <div className="flex items-center gap-3">
        <Submit />
        {state.ok ? (
          <span className="text-sm text-emerald-700">{state.notice ?? "Готово"}</span>
        ) : state.error ? (
          <span className="text-sm text-rose-600">{state.error}</span>
        ) : null}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <div className="pt-1">{children}</div>
    </div>
  );
}
