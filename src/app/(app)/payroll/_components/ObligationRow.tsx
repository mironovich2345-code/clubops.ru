"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { settleObligation, writeOffObligation, type ObligationState } from "../obligations/actions";
import { formatKopeks } from "@/lib/money";

const initial: ObligationState = { ok: false };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "..." : label}
    </button>
  );
}

export function ObligationRow({
  obligationId,
  directionLabel,
  isEmployeeDebt,
  outstandingKopeks,
  canSettle,
  canWriteOff,
  canCash,
  canBank,
}: {
  obligationId: string;
  directionLabel: string;
  isEmployeeDebt: boolean;
  outstandingKopeks: number;
  canSettle: boolean;
  canWriteOff: boolean;
  canCash: boolean;
  canBank: boolean;
}) {
  const [settleState, settle] = useFormState(settleObligation, initial);
  const [writeState, writeOff] = useFormState(writeOffObligation, initial);
  const [showWrite, setShowWrite] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <span className={`text-sm font-medium ${isEmployeeDebt ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
          {formatKopeks(outstandingKopeks)}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{directionLabel}</span>
        {canSettle ? (
          <form action={settle} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="obligationId" value={obligationId} />
            <select name="method" defaultValue={canCash ? "cash" : "bank"} className="input text-sm">
              {canCash ? <option value="cash">Наличные</option> : null}
              {canBank ? <option value="bank">Безнал</option> : null}
            </select>
            <input name="amount" type="number" min="0" step="0.01" className="input w-24 text-sm" placeholder="Сумма" />
            <Submit label="Погасить" />
          </form>
        ) : null}
        {canWriteOff ? (
          <button type="button" onClick={() => setShowWrite((v) => !v)} className="text-xs text-slate-400 hover:text-rose-600">
            списать
          </button>
        ) : null}
      </div>
      {settleState.error ? <div className="text-xs text-rose-600">{settleState.error}</div> : null}

      {canWriteOff && showWrite ? (
        <form action={writeOff} className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/40">
          <input type="hidden" name="obligationId" value={obligationId} />
          <label className="block grow">
            <span className="mb-1 block text-[11px] text-slate-500">Причина списания (обязательно)</span>
            <input name="comment" required className="input w-full text-sm" />
          </label>
          <Submit label="Списать" />
          {writeState.error ? <span className="w-full text-xs text-rose-600">{writeState.error}</span> : null}
        </form>
      ) : null}
    </div>
  );
}
