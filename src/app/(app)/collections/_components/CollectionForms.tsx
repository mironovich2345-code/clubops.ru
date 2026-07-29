"use client";

import { useFormState, useFormStatus } from "react-dom";
import { buttonClass } from "@/components/mobile/buttons";
import { DateField } from "@/components/mobile/DateField";
import { MobileFileField } from "@/components/mobile/MobileFileField";
import {
  createCashCollection,
  createCashWithdrawal,
  approveCashCollection,
  rejectCashCollection,
  approveCashWithdrawal,
  rejectCashWithdrawal,
  cancelCashCollection,
  cancelCashWithdrawal,
  createCashOtherIncome,
  approveCashOtherIncome,
  rejectCashOtherIncome,
  cancelCashOtherIncome,
  setCashOpeningBalance,
  syncIpCashAction,
  syncOooCashAction,
  type CashState,
} from "../actions";

const initial: CashState = { ok: false };
type ClubOpt = { id: string; name: string };

function Submit({ idle, busy, variant = "primary", fluid = false }: { idle: string; busy: string; variant?: "primary" | "secondary"; fluid?: boolean }) {
  const { pending } = useFormStatus();
  // Primary CTA — full-width on mobile (48px), auto on desktop. `fluid` keeps it full-width
  // everywhere (used for the equal-width sync buttons).
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant, size: "cta", block: true })} ${fluid ? "" : "sm:w-auto"}`}>
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
  // Two equal-width SECONDARY buttons (system operation — not the page's primary CTA, §8).
  return (
    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
      <form action={ipAction} className="min-w-0"><Submit idle="Синхронизировать наличные ИП" busy="Синхронизация..." variant="secondary" fluid /></form>
      <form action={oooAction} className="min-w-0"><Submit idle="Синхронизировать наличные ООО" busy="Синхронизация..." variant="secondary" fluid /></form>
      <div className="min-[420px]:col-span-2"><Msg s={ipState.ok || ipState.error ? ipState : oooState} /></div>
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
      <DateField label="Дата контрольного остатка" name="snapshotDate" required defaultValue={today} />
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
      <DateField label="Дата инкассации" name="operationDate" required defaultValue={today} />
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Комментарий</span><input name="comment" className="input" /></label>
      <label className="block md:col-span-2">
        <span className="mb-1 block text-sm font-medium text-slate-700">Подтверждающие документы (1–3: JPG, PNG, WEBP, PDF)</span>
        <MobileFileField name="documents" maxFiles={3} required />
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
      <DateField label="Дата изъятия" name="operationDate" required defaultValue={today} />
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Комментарий</span><input name="comment" className="input" /></label>
      <label className="block md:col-span-2">
        <span className="mb-1 block text-sm font-medium text-slate-700">Подтверждающий документ (1–3: JPG, PNG, WEBP, PDF)</span>
        <MobileFileField name="documents" maxFiles={3} required />
      </label>
      <div className="md:col-span-2 flex items-center justify-between gap-3">
        <Msg s={state} />
        <Submit idle="Изъять из ООО в ИП" busy="Отправка..." />
      </div>
    </form>
  );
}

export function OtherIncomeForm({ clubs, today }: { clubs: ClubOpt[]; today: string }) {
  const [state, action] = useFormState(createCashOtherIncome, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ClubSelect clubs={clubs} />
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Сумма, ₽</span><input name="amount" inputMode="decimal" required placeholder="0" className="input" /></label>
      <DateField label="Дата поступления" name="operationDate" required defaultValue={today} />
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">Источник</span>
        <select name="source" defaultValue="regional" className="input">
          <option value="regional">Региональный директор</option>
          <option value="owner">Собственник</option>
          <option value="general_director">Генеральный директор</option>
          <option value="other">Другое</option>
        </select>
      </label>
      <label className="block md:col-span-2"><span className="mb-1 block text-sm font-medium text-slate-700">Комментарий (обязательно)</span><input name="comment" required className="input" /></label>
      <label className="block md:col-span-2">
        <span className="mb-1 block text-sm font-medium text-slate-700">Документы (необязательно, до 3: JPG, PNG, WEBP, PDF)</span>
        <MobileFileField name="documents" maxFiles={3} />
      </label>
      <div className="md:col-span-2 flex items-center justify-between gap-3">
        <Msg s={state} />
        <Submit idle="Добавить приход «Иное»" busy="Отправка..." />
      </div>
    </form>
  );
}

type OpKind = "collection" | "withdrawal" | "other_income";
export function CancelButton({ id, kind }: { id: string; kind: OpKind }) {
  const cancel = kind === "collection" ? cancelCashCollection : kind === "withdrawal" ? cancelCashWithdrawal : cancelCashOtherIncome;
  const [state, action] = useFormState(cancel, initial);
  return (
    <details className="inline-block">
      <summary className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">Отменить</summary>
      <form action={action} className="mt-2 flex flex-col gap-1.5 rounded-md border border-slate-200 bg-white p-2 shadow-sm">
        <input type="hidden" name="id" value={id} />
        <input name="reason" placeholder="Причина отмены (необязательно)" className="input text-xs" />
        <button type="submit" className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100">Подтвердить отмену</button>
        <Msg s={state} />
      </form>
    </details>
  );
}

export function ReviewButtons({ id, kind }: { id: string; kind: OpKind }) {
  const approve = kind === "collection" ? approveCashCollection : kind === "withdrawal" ? approveCashWithdrawal : approveCashOtherIncome;
  const reject = kind === "collection" ? rejectCashCollection : kind === "withdrawal" ? rejectCashWithdrawal : rejectCashOtherIncome;
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
