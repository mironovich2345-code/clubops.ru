"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { setOpeningBalanceAction, createOtherIncomeAction, createTransferAction, confirmTransferAction } from "../cash-actions";

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

export function TransferForm({ regionals, canCreateToRegional, canCreateToClub }: { regionals: Regional[]; canCreateToRegional: boolean; canCreateToClub: boolean }) {
  const [state, action] = useFormState(createTransferAction, initial);
  const [direction, setDirection] = useState<string>(canCreateToRegional ? "to_regional" : "to_club");
  const showRecipient = direction === "to_regional";
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Направление</span>
          <select name="direction" value={direction} onChange={(e) => setDirection(e.target.value)} className="input">
            {canCreateToRegional ? <option value="to_regional">Клуб → Директор</option> : null}
            {canCreateToClub ? <option value="to_club">Директор → Клуб</option> : null}
          </select>
        </label>
        {showRecipient ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Директор (получатель)</span>
            <select name="regionalUserId" required defaultValue="" className="input">
              <option value="" disabled>Выберите директора</option>
              {regionals.map((r) => <option key={r.userId} value={r.userId}>{r.name}</option>)}
            </select>
          </label>
        ) : (
          <div className="text-xs text-slate-500">Получатель: клуб</div>
        )}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Сумма, ₽</span>
          <input name="amount" required inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*" className="input" placeholder="0,00" />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Комментарий</span>
        <input name="comment" className="input w-full" placeholder="Например: закупка расходников" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Submit label="Создать перевод" />
        {state.ok ? <span className="text-xs text-emerald-700">Перевод создан. Ожидает подтверждения получателем.</span> : null}
        {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      </div>
    </form>
  );
}

type TransferRow = {
  id: string; directionLabel: string; amountText: string; dateText: string; comment: string | null;
  confirmed: boolean; statusLabel: string; counterpartyLabel: string;
  confirmedByName: string | null; confirmedAtText: string | null; canConfirm: boolean;
};

function ConfirmReceiptButton({ id }: { id: string }) {
  const [state, action] = useFormState(confirmTransferAction, initial);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="movementId" value={id} />
      <Confirm />
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60">
      {pending ? "…" : "Подтвердить получение"}
    </button>
  );
}

/** Compact two-way transfer list; the confirm button shows only to the recipient. */
export function PendingTransfers({ rows }: { rows: TransferRow[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div className="min-w-0 text-sm text-slate-700">
            <span className="font-medium">{r.directionLabel}</span> · {r.amountText} · {r.dateText}
            {r.comment ? <span className="ml-1 text-xs text-slate-500">· {r.comment}</span> : null}
            <div className="text-xs text-slate-500">
              {r.counterpartyLabel} ·{" "}
              <span className={r.confirmed ? "text-emerald-700" : "text-amber-700"}>{r.statusLabel}</span>
              {r.confirmed && r.confirmedByName ? <> · подтвердил: {r.confirmedByName}{r.confirmedAtText ? ` (${r.confirmedAtText})` : ""}</> : null}
            </div>
          </div>
          {r.canConfirm ? <ConfirmReceiptButton id={r.id} /> : null}
        </li>
      ))}
    </ul>
  );
}
