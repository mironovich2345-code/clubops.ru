"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { resendRecovery, startAlternateRestore, confirmAlternateRestore } from "../actions";

type State = { ok: boolean; error?: string; stage?: "start" | "otp"; deletionId?: string; newEmail?: string };
const initial: State = { ok: false, stage: "start" };

function Mini({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60">{pending ? "..." : label}</button>;
}

export function AccountActions({ deletionId, restorable }: { deletionId: string; restorable: boolean }) {
  const [open, setOpen] = useState(false);
  const [startState, startAction] = useFormState(startAlternateRestore, initial);
  const [confirmState, confirmAction] = useFormState(confirmAlternateRestore, initial);
  const stage = confirmState.stage ?? (startState.ok ? "otp" : startState.stage ?? "start");
  const newEmail = startState.newEmail ?? confirmState.newEmail ?? "";

  if (!restorable) return <span className="text-xs text-slate-400">—</span>;

  return (
    <div className="flex flex-col gap-2">
      <form action={resendRecovery}>
        <input type="hidden" name="deletionId" value={deletionId} />
        <Mini label="Отправить письмо восстановления" />
      </form>

      {!open ? (
        <button onClick={() => setOpen(true)} className="text-left text-xs text-brand-600 underline">Восстановить на другой email…</button>
      ) : stage === "otp" ? (
        <form action={confirmAction} className="flex flex-col gap-1.5 rounded-md border border-slate-200 p-2">
          <input type="hidden" name="deletionId" value={deletionId} />
          <input type="hidden" name="newEmail" value={newEmail} />
          <span className="text-xs text-slate-500">Код отправлен на {newEmail}</span>
          <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} name="code" required className="input" placeholder="Код" />
          <input type="password" name="password" required minLength={8} className="input" placeholder="Новый пароль" />
          <Mini label="Восстановить" />
          {confirmState.error ? <span className="text-xs text-rose-600">{confirmState.error}</span> : null}
        </form>
      ) : (
        <form action={startAction} className="flex flex-col gap-1.5 rounded-md border border-slate-200 p-2">
          <input type="hidden" name="deletionId" value={deletionId} />
          <input type="email" name="newEmail" required className="input" placeholder="Новый email" />
          <Mini label="Отправить код" />
          {startState.error ? <span className="text-xs text-rose-600">{startState.error}</span> : null}
        </form>
      )}
    </div>
  );
}
