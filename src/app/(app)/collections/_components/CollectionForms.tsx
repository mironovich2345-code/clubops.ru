"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  createCashCollection,
  createCashWithdrawal,
  approveCashCollection,
  rejectCashCollection,
  approveCashWithdrawal,
  rejectCashWithdrawal,
  setCashOpeningBalance,
  syncIpCashAction,
  syncOooCashAction,
  type CashState,
} from "../actions";

const initial: CashState = { ok: false };
type ClubOpt = { id: string; name: string };

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? busy : idle}
    </button>
  );
}
function Msg({ s }: { s: CashState }) {
  if (s.ok && s.notice) return <p className="mt-2 text-sm text-emerald-700">{s.notice}</p>;
  if (s.error) return <p className="mt-2 text-sm text-rose-600">{s.error}</p>;
  return null;
}
function ClubSelect({ clubs }: { clubs: ClubOpt[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">Клуб</span>
      <select name="clubId" required defaultValue={clubs.length === 1 ? clubs[0].id : ""} className="input">
        {clubs.length === 1 ? null : <option value="" disabled>Выберите клуб</option>}
        {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

export function CashSyncButtons() {
  const [ipState, ipAction] = useFormState(syncIpCashAction, initial);
  const [oooState, oooAction] = useFormState(syncOooCashAction, initial);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <form action={ipAction}><Submit idle="Синхронизировать наличные ИП" busy="Синхронизация..." /></form>
      <form action={oooAction}><Submit idle="Синхронизировать наличные ООО" busy="Синхронизация..." /></form>
      <div className="w-full"><Msg s={ipState.ok || ipState.error ? ipState : oooState} /></div>
    </div>
  );
}

export function OpeningBalanceForm({ clubs, today, entity }: { clubs: ClubOpt[]; today: string; entity?: "ooo" | "ip" }) {
  const [state, action] = useFormState(setCashOpeningBalance, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ClubSelect clubs={clubs} />
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Юрлицо</span>
        {entity ? (
          <>
            <input type="hidden" name="entity" value={entity} />
            <input disabled value={entity === "ooo" ? "ООО" : "ИП"} className="input" />
          </>
        ) : (
          <select name="entity" required defaultValue="" className="input">
            <option value="" disabled>Выберите юрлицо</option>
            <option value="ooo">ООО</option>
            <option value="ip">ИП</option>
          </select>
        )}
      </label>
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Дата контрольного остатка</span><input type="date" name="snapshotDate" required defaultValue={today} className="input" /></label>
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Сумма в кассе, ₽</span><input name="amount" inputMode="decimal" required placeholder="0" className="input" /></label>
      <label className="block md:col-span-2"><span className="mb-1 block text-sm font-medium text-slate-700">Комментарий (обязательно)</span><input name="comment" required className="input" /></label>
      <div className="md:col-span-2 flex items-center justify-between gap-3">
        <Msg s={state} />
        <Submit idle="Сохранить контрольный остаток" busy="Сохранение..." />
      </div>
    </form>
  );
}

export function IpCashSyncButton() {
  const [state, action] = useFormState(syncIpCashAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Submit idle="Синхронизировать наличные ИП" busy="Синхронизация..." />
      <Msg s={state} />
    </form>
  );
}

export function CollectionForm({ clubs, today }: { clubs: ClubOpt[]; today: string }) {
  const [state, action] = useFormState(createCashCollection, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ClubSelect clubs={clubs} />
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Сумма, ₽</span><input name="amount" inputMode="decimal" required placeholder="0" className="input" /></label>
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Дата инкассации</span><input type="date" name="operationDate" required defaultValue={today} className="input" /></label>
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Комментарий</span><input name="comment" className="input" /></label>
      <label className="block md:col-span-2">
        <span className="mb-1 block text-sm font-medium text-slate-700">Подтверждающие документы (1–3: JPG, PNG, WEBP, PDF)</span>
        <input type="file" name="documents" multiple required accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full text-sm" />
      </label>
      <div className="md:col-span-2 flex items-center justify-between gap-3">
        <Msg s={state} />
        <Submit idle="Инкассировать ООО" busy="Отправка..." />
      </div>
    </form>
  );
}

export function WithdrawalForm({ clubs, today }: { clubs: ClubOpt[]; today: string }) {
  const [state, action] = useFormState(createCashWithdrawal, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ClubSelect clubs={clubs} />
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Сумма, ₽</span><input name="amount" inputMode="decimal" required placeholder="0" className="input" /></label>
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Дата изъятия</span><input type="date" name="operationDate" required defaultValue={today} className="input" /></label>
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Комментарий</span><input name="comment" className="input" /></label>
      <label className="block md:col-span-2">
        <span className="mb-1 block text-sm font-medium text-slate-700">Подтверждающий документ (1–3: JPG, PNG, WEBP, PDF)</span>
        <input type="file" name="documents" multiple required accept="image/jpeg,image/png,image/webp,application/pdf" className="block w-full text-sm" />
      </label>
      <div className="md:col-span-2 flex items-center justify-between gap-3">
        <Msg s={state} />
        <Submit idle="Изъять из ООО в ИП" busy="Отправка..." />
      </div>
    </form>
  );
}

export function ReviewButtons({ id, kind }: { id: string; kind: "collection" | "withdrawal" }) {
  const approve = kind === "collection" ? approveCashCollection : approveCashWithdrawal;
  const reject = kind === "collection" ? rejectCashCollection : rejectCashWithdrawal;
  const [aState, aAction] = useFormState(approve, initial);
  const [rState, rAction] = useFormState(reject, initial);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={aAction}><input type="hidden" name="id" value={id} /><button type="submit" className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100">Подтвердить</button></form>
      <form action={rAction}><input type="hidden" name="id" value={id} /><button type="submit" className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100">Отклонить</button></form>
      <Msg s={aState.ok || aState.error ? aState : rState} />
    </div>
  );
}
