"use client";

import { useFormState, useFormStatus } from "react-dom";
import { setOpeningBalanceAction, createOtherIncomeAction, createTransferAction } from "../cash-actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };
type Regional = { userId: string; name: string };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">{pending ? "…" : label}</button>;
}

export function OpeningBalanceForm() {
  const [state, action] = useFormState(setOpeningBalanceAction, initial);
  if (state.ok) return <p className="text-sm text-emerald-700">Начальный остаток задан.</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Начальный остаток, ₽</span>
        <input name="amount" required inputMode="decimal" className="input" placeholder="0,00" /></label>
      <Submit label="Задать" />
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

export function OtherIncomeForm() {
  const [state, action] = useFormState(createOtherIncomeAction, initial);
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Сумма, ₽</span>
          <input name="amount" required inputMode="decimal" className="input" placeholder="0,00" /></label>
        <label className="block flex-1"><span className="mb-1 block text-xs font-medium text-slate-600">Комментарий (кто и откуда)</span>
          <input name="comment" required className="input w-full" placeholder="Собственник привёз наличные" /></label>
        <Submit label="Создать приход" />
      </div>
      {state.ok ? <span className="text-xs text-emerald-700">Приход создан. Ожидает подтверждения получателем.</span> : null}
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

export function TransferForm({ regionals, canReturnFromRegional }: { regionals: Regional[]; canReturnFromRegional: boolean }) {
  const [state, action] = useFormState(createTransferAction, initial);
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Направление</span>
          <select name="direction" defaultValue="to_regional" className="input">
            <option value="to_regional">Клуб → региональному директору</option>
            {canReturnFromRegional ? <option value="to_club">Мой кошелёк → клуб</option> : null}
          </select></label>
        <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Региональный директор</span>
          <select name="regionalUserId" defaultValue="" className="input">
            <option value="">—</option>
            {regionals.map((r) => <option key={r.userId} value={r.userId}>{r.name}</option>)}
          </select></label>
        <label className="block"><span className="mb-1 block text-xs font-medium text-slate-600">Сумма, ₽</span>
          <input name="amount" required inputMode="decimal" className="input" placeholder="0,00" /></label>
        <Submit label="Создать перевод" />
      </div>
      {state.ok ? <span className="text-xs text-emerald-700">Перевод создан. Ожидает подтверждения получателем.</span> : null}
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}
