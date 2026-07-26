"use client";

import { useFormState, useFormStatus } from "react-dom";
import { syncIdentitiesAction, type CashierActionState } from "../ofd-cashiers/actions";

const initial: CashierActionState = { ok: false };

function Btn() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">{pending ? "Синхронизация..." : "Обновить из чеков"}</button>;
}

/** Rebuild cashier identities + suggestions from receipts (idempotent). */
export function CashierSyncButton({ club }: { club?: string }) {
  const [state, action] = useFormState(syncIdentitiesAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      {club ? <input type="hidden" name="club" value={club} /> : null}
      <Btn />
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      {state.ok && state.notice ? <span className="text-xs text-emerald-600">{state.notice}</span> : null}
    </form>
  );
}
