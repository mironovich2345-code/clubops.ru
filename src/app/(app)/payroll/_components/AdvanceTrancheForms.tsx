"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { addAdvanceTranche, reverseAdvanceTranche, increaseApprovedAmount, type AdvanceState } from "../advance-actions";
import { formatKopeks } from "@/lib/money";

const initial: AdvanceState = { ok: false };

function Btn({ label, variant = "primary" }: { label: string; variant?: "primary" | "neutral" | "danger" }) {
  const { pending } = useFormStatus();
  const cls = variant === "primary" ? "bg-brand-600 text-white hover:bg-brand-700" : variant === "danger" ? "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return <button type="submit" disabled={pending} className={`inline-flex min-h-[44px] items-center justify-center rounded-md px-4 py-2 text-sm font-medium shadow-sm disabled:opacity-60 ${cls}`}>{pending ? "…" : label}</button>;
}

/** Add a tranche. idempotencyKey is generated once per form and regenerated after a
 * successful submit so a browser back/refresh cannot create a second payment. */
export function AddTrancheForm({ advanceId, canCash, canBank, approvedKopeks, paidKopeks }: { advanceId: string; canCash: boolean; canBank: boolean; approvedKopeks: number; paidKopeks: number }) {
  const [state, action] = useFormState(addAdvanceTranche, initial);
  const [key, setKey] = useState(() => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())));
  const [amount, setAmount] = useState("");
  const remaining = Math.max(0, approvedKopeks - paidKopeks);
  const newKopeks = Math.round((Number(amount.replace(",", ".")) || 0) * 100);
  if (!canCash && !canBank) return null;
  if (remaining <= 0) return <p className="text-sm text-emerald-700">Аванс выплачен полностью.</p>;
  return (
    <form action={action} onSubmit={() => { if (state.ok) setKey(crypto.randomUUID?.() ?? String(Date.now())); }} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Добавить выплату (транш)</div>
      <input type="hidden" name="advanceId" value={advanceId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <div className="flex flex-col gap-3">
        <label className="block"><span className="mb-1 block text-xs text-slate-600 dark:text-slate-400">Способ</span>
          <select name="method" defaultValue={canCash ? "cash" : "bank"} className="input min-h-[44px] w-full">
            {canCash ? <option value="cash">Наличные</option> : null}
            {canBank ? <option value="bank">Безнал</option> : null}
          </select>
        </label>
        <label className="block"><span className="mb-1 block text-xs text-slate-600 dark:text-slate-400">Сумма, ₽</span>
          <input name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" type="text" className="input min-h-[44px] w-full" placeholder={(remaining / 100).toString()} />
        </label>
        <div className="rounded-md bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800/40">
          Согласовано {formatKopeks(approvedKopeks)} · выплачено {formatKopeks(paidKopeks)} · остаток {formatKopeks(remaining)}
          {newKopeks > 0 ? <> · после выплаты остаток <b>{formatKopeks(Math.max(0, remaining - newKopeks))}</b></> : null}
          {newKopeks > remaining ? <div className="mt-1 text-rose-600">Транш превышает остаток согласованной суммы.</div> : null}
        </div>
        <Btn label="Выплатить транш" />
        {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}

/** Storno one tranche — visually separated (danger) and requires confirmation. */
export function ReverseTrancheButton({ trancheId }: { trancheId: string }) {
  const [state, action] = useFormState(reverseAdvanceTranche, initial);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="min-h-[36px] rounded-md border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50">Сторно</button>;
  return (
    <form action={action} className="flex flex-col gap-1 rounded-md border border-rose-200 bg-rose-50/50 p-2">
      <input type="hidden" name="trancheId" value={trancheId} />
      <input name="reason" className="input py-1 text-xs" placeholder="Причина сторно" />
      <div className="flex items-center gap-1">
        <Btn label="Подтвердить сторно" variant="danger" />
        <button type="button" onClick={() => setOpen(false)} className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600">Отмена</button>
      </div>
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

/** Increase the approved amount (needs re-approval; owner/GD/regional). */
export function IncreaseApprovedForm({ advanceId, canApprove }: { advanceId: string; canApprove: boolean }) {
  const [state, action] = useFormState(increaseApprovedAmount, initial);
  const [open, setOpen] = useState(false);
  if (!canApprove) return null;
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">Увеличить согласованную сумму</button>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-800/40">
      <input type="hidden" name="advanceId" value={advanceId} />
      <label className="block"><span className="mb-1 block text-xs text-slate-600">Новая согласованная сумма, ₽</span><input name="approvedAmount" inputMode="decimal" className="input min-h-[44px]" /></label>
      <Btn label="Согласовать" variant="neutral" />
      <button type="button" onClick={() => setOpen(false)} className="min-h-[44px] rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-600">Отмена</button>
      {state.ok ? <span className="w-full text-xs text-emerald-700">{state.notice}</span> : state.error ? <span className="w-full text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}
