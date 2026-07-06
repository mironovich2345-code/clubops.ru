"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { startOwnerDeletion, confirmOwnerDeletion } from "../actions";

type State = { ok: boolean; stage?: "start" | "otp"; error?: string; targetUserId?: string };
const initial: State = { ok: false, stage: "start" };

function Mini({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-60">{pending ? "..." : label}</button>;
}

export function OwnerDeleteControl({ targetUserId }: { targetUserId: string }) {
  const [open, setOpen] = useState(false);
  const [startState, startAction] = useFormState(startOwnerDeletion, initial);
  const [confirmState, confirmAction] = useFormState(confirmOwnerDeletion, initial);
  const stage = confirmState.stage ?? (startState.ok ? "otp" : startState.stage ?? "start");

  if (confirmState.ok) return <span className="text-xs text-slate-500">Аккаунт удалён.</span>;
  if (!open) return <button onClick={() => setOpen(true)} className="text-left text-xs text-rose-600 underline">Удалить аккаунт…</button>;

  return stage === "otp" ? (
    <form action={confirmAction} className="flex flex-col gap-1.5 rounded-md border border-rose-200 p-2">
      <input type="hidden" name="targetUserId" value={targetUserId} />
      <span className="text-xs text-slate-500">Код отправлен вам на email.</span>
      <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} name="code" required className="input" placeholder="Код" />
      <Mini label="Подтвердить удаление" />
      {confirmState.error ? <span className="text-xs text-rose-600">{confirmState.error}</span> : null}
    </form>
  ) : (
    <form action={startAction} className="flex flex-col gap-1.5 rounded-md border border-rose-200 p-2">
      <input type="hidden" name="targetUserId" value={targetUserId} />
      <span className="text-xs text-slate-600">Удаление освободит email; финансовая история сохранится; восстановление 30 дней.</span>
      <input type="password" name="password" required autoComplete="current-password" className="input" placeholder="Ваш пароль" />
      <Mini label="Продолжить" />
      {startState.error ? <span className="text-xs text-rose-600">{startState.error}</span> : null}
    </form>
  );
}
