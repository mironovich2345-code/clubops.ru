"use client";

import { useFormState } from "react-dom";
import { reviewDailyCashReconciliation, type ReconState } from "../reconciliation-actions";

const initial: ReconState = { ok: false };

export function ReconciliationReview({
  reconciliationId,
  canRegional,
  canAccounting,
  needsRegional,
  needsAccounting,
}: {
  reconciliationId: string;
  canRegional: boolean;
  canAccounting: boolean;
  needsRegional: boolean; // discrepancy not yet regional-confirmed
  needsAccounting: boolean; // ready for accounting close
}) {
  const [state, action] = useFormState(reviewDailyCashReconciliation, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="reconciliationId" value={reconciliationId} />
      <input name="resolution" placeholder="Решение / примечание" className="input w-44 text-xs" />
      {canRegional && needsRegional ? (
        <button type="submit" name="decision" value="regional_confirm" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Подтвердить (регионал)
        </button>
      ) : null}
      {canAccounting && needsAccounting ? (
        <button type="submit" name="decision" value="accounting_confirm" className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700">
          Закрыть (бухгалтер)
        </button>
      ) : null}
      {state.error ? <span className="w-full text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}
