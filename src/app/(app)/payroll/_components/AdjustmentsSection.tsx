"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { addAdjustment, cancelAdjustment, type PayrollAdjustmentState } from "../periods/actions";
import { formatKopeks } from "@/lib/money";

const initial: PayrollAdjustmentState = { ok: false };

export type AdjustmentRow = { id: string; type: string; direction: string; amountKopeks: number; comment: string | null };

const TYPE_LABELS: Record<string, string> = {
  bonus: "Премия",
  penalty: "Штраф",
  overpayment_recovery: "Удержание переплаты",
  shortage_recovery: "Удержание недостачи",
  trainer_credit_recovery: "Удержание кредита тренера",
  correction: "Корректировка",
  other: "Прочее",
};
// Types offered in the UI. Recovery types belong to the debts flow (Stage 6).
const TYPE_OPTIONS = ["bonus", "penalty", "correction", "other"];
const DIRECTION_FROM_FORM = new Set(["correction", "other"]);

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "..." : "Добавить"}
    </button>
  );
}

export function AdjustmentsSection({
  calculationId,
  adjustments,
  canAdd,
}: {
  calculationId: string;
  adjustments: AdjustmentRow[];
  canAdd: boolean;
}) {
  const [state, action] = useFormState(addAdjustment, initial);
  const [type, setType] = useState("bonus");

  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800/70">
      <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Корректировки</div>
      {adjustments.length === 0 ? (
        <div className="mb-2 text-xs text-slate-400">Нет корректировок.</div>
      ) : (
        <ul className="mb-3 space-y-1">
          {adjustments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-600 dark:text-slate-300">
                <span className={a.direction === "credit" ? "text-emerald-600" : "text-rose-600"}>
                  {a.direction === "credit" ? "+" : "−"}{formatKopeks(a.amountKopeks)}
                </span>{" "}
                · {TYPE_LABELS[a.type] ?? a.type}
                {a.comment ? <span className="text-slate-400"> — {a.comment}</span> : null}
              </span>
              {canAdd ? (
                <form action={cancelAdjustment} onSubmit={(e) => { if (!window.confirm("Отменить корректировку?")) e.preventDefault(); }}>
                  <input type="hidden" name="adjustmentId" value={a.id} />
                  <button type="submit" className="text-slate-400 hover:text-rose-600">✕</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canAdd ? (
        <form action={action} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="calculationId" value={calculationId} />
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-500">Тип</span>
            <select name="type" value={type} onChange={(e) => setType(e.target.value)} className="input text-sm">
              {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          {DIRECTION_FROM_FORM.has(type) ? (
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500">Направление</span>
              <select name="direction" defaultValue="credit" className="input text-sm">
                <option value="credit">Начисление (+)</option>
                <option value="debit">Удержание (−)</option>
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-500">Сумма, ₽</span>
            <input name="amount" type="number" min="0" step="0.01" className="input w-28 text-sm" />
          </label>
          <label className="block grow">
            <span className="mb-1 block text-[11px] text-slate-500">Комментарий (обязательно)</span>
            <input name="comment" required className="input w-full text-sm" />
          </label>
          <Submit />
          {state.error ? <span className="w-full text-xs text-rose-600">{state.error}</span> : null}
        </form>
      ) : null}
    </div>
  );
}
