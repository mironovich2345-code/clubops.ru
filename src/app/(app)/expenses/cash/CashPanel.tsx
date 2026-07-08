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

type IpOption = { id: string; name: string };

export function OpeningBalanceForm({ ipOptions, defaultDate, clubName }: { ipOptions: IpOption[]; defaultDate: string; clubName: string | null }) {
  const [state, action] = useFormState(setOpeningBalanceAction, initial);
  if (state.ok) return <p className="text-sm text-emerald-700">Начальный остаток задан.</p>;
  const singleIp = ipOptions.length === 1 ? ipOptions[0] : null;
  return (
    <form action={action} className="flex flex-col gap-3">
      {/* Клуб — из серверного scope, только для показа (нельзя подменить clubId). */}
      <div className="text-xs text-slate-600">Клуб: <span className="font-medium text-slate-800">{clubName ?? "—"}</span></div>

      {/* ИП — единственное подставляется автоматически; иначе выбор. */}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">ИП</span>
        {singleIp ? (
          <>
            <input type="hidden" name="legalEntityId" value={singleIp.id} />
            <div className="text-sm text-slate-800">{singleIp.name}</div>
          </>
        ) : (
          <select name="legalEntityId" required defaultValue="" className="input w-full max-w-xs">
            <option value="" disabled>Выберите ИП</option>
            {ipOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </label>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Сумма начального остатка, ₽</span>
          <input name="amount" required inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" defaultValue="0" className="input" placeholder="0,00" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Дата остатка</span>
          <input type="date" name="occurredAt" required defaultValue={defaultDate} max={defaultDate} className="input" />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Комментарий</span>
        <input name="comment" required maxLength={300} className="input w-full" placeholder="Фактический остаток наличных при запуске кассового учёта" />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Submit label="Задать начальный остаток" />
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </div>
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
