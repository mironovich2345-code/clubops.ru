"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { buttonClass } from "@/components/mobile/buttons";
import { DateField } from "@/components/mobile/DateField";
import {
  createRegionalTransfer,
  confirmRegionalTransfer,
  cancelRegionalTransfer,
  correctBalanceSnapshot,
  type CashState,
} from "../actions";

const initial: CashState = { ok: false };
type ClubOpt = { id: string; name: string };
type Director = { id: string; name: string };

function Submit({ idle, busy, variant = "primary" }: { idle: string; busy: string; variant?: "primary" | "secondary" }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant, size: "cta", block: true })} sm:w-auto`}>
      {pending ? busy : idle}
    </button>
  );
}
function Msg({ s }: { s: CashState }) {
  if (s.ok && s.notice) return <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{s.notice}</p>;
  if (s.error) return <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{s.error}</p>;
  return null;
}

/**
 * «Передать деньги региональному директору» — internal cash movement. Recipient list is
 * the club's eligible ACTIVE regional directors only; a single eligible director is
 * preselected but still shown. A fresh idempotencyKey per render blocks double submit.
 */
export function RegionalTransferForm({ clubs, directorsByClub, today }: { clubs: ClubOpt[]; directorsByClub: Record<string, Director[]>; today: string }) {
  const [state, action] = useFormState(createRegionalTransfer, initial);
  const [clubId, setClubId] = useState(clubs.length === 1 ? clubs[0].id : "");
  // A stable per-mount key; regenerated after a successful submit via the state identity.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [state]);
  const directors = clubId ? directorsByClub[clubId] ?? [] : [];

  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Клуб</span>
        <select name="clubId" required value={clubId} onChange={(e) => setClubId(e.target.value)} className="input w-full">
          {clubs.length === 1 ? null : <option value="" disabled>Выберите клуб</option>}
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Сумма, ₽</span><input name="amount" inputMode="decimal" required placeholder="0" className="input w-full" /></label>
      <DateField label="Дата передачи" name="operationDate" required defaultValue={today} />
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Получатель (региональный директор)</span>
        <select name="recipientRegionalDirectorId" required defaultValue={directors.length === 1 ? directors[0].id : ""} className="input w-full" disabled={!clubId || directors.length === 0}>
          {directors.length === 1 ? null : <option value="" disabled>Выберите получателя</option>}
          {directors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {clubId && directors.length === 0 ? <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">Нет активных региональных директоров с доступом к этому клубу.</span> : null}
      </label>
      <label className="block md:col-span-2"><span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Комментарий (необязательно)</span><input name="comment" className="input w-full" /></label>
      <div className="md:col-span-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Msg s={state} />
        <Submit idle="Передать региональному директору" busy="Отправка..." />
      </div>
    </form>
  );
}

/** Manager-of-this-club confirms receipt (server re-checks the explicit-manager rule). */
export function TransferConfirmButton({ id }: { id: string }) {
  const [state, action] = useFormState(confirmRegionalTransfer, initial);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">Подтвердить передачу</button>
      <Msg s={state} />
    </form>
  );
}

export function TransferCancelButton({ id }: { id: string }) {
  const [state, action] = useFormState(cancelRegionalTransfer, initial);
  return (
    <details className="inline-block">
      <summary className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">Отменить</summary>
      <form action={action} className="mt-2 flex flex-col gap-1.5 rounded-md border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <input type="hidden" name="id" value={id} />
        <input name="reason" placeholder="Причина отмены (необязательно)" className="input text-xs" />
        <button type="submit" className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100">Подтвердить отмену</button>
        <Msg s={state} />
      </form>
    </details>
  );
}

/**
 * «Скорректировать контрольную точку» — append-only correction. Requires a reason; the old
 * version is kept and the new one supersedes it. Shown per active control point in history.
 */
export function SnapshotCorrectionButton({ snapshotId }: { snapshotId: string }) {
  const [state, action] = useFormState(correctBalanceSnapshot, initial);
  return (
    <details className="inline-block">
      <summary className="cursor-pointer text-xs font-medium text-brand-600 dark:text-brand-400">Скорректировать</summary>
      <form action={action} className="mt-2 flex flex-col gap-1.5 rounded-md border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <input type="hidden" name="snapshotId" value={snapshotId} />
        <input name="amount" inputMode="decimal" required placeholder="Новая сумма, ₽" className="input text-xs" />
        <input name="reason" required placeholder="Причина корректировки (обязательно)" className="input text-xs" />
        <button type="submit" className={`${buttonClass({ variant: "primary", size: "sm" })}`}>Сохранить новую версию</button>
        <Msg s={state} />
      </form>
    </details>
  );
}
