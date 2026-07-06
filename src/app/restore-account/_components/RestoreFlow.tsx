"use client";

import { useFormState, useFormStatus } from "react-dom";
import { startRestore, confirmRestore } from "../actions";

type State = { ok: boolean; stage?: "start" | "otp"; error?: string; masked?: string };
const initial: State = { ok: false, stage: "start" };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
      {pending ? "..." : label}
    </button>
  );
}

export function RestoreFlow({ token, masked }: { token: string; masked: string }) {
  const [startState, startAction] = useFormState(startRestore, initial);
  const [confirmState, confirmAction] = useFormState(confirmRestore, initial);
  const stage = confirmState.stage ?? (startState.ok ? "otp" : startState.stage ?? "start");
  const maskedEmail = startState.masked ?? masked;

  if (stage === "otp") {
    return (
      <form action={confirmAction} className="space-y-3">
        <input type="hidden" name="token" value={token} />
        <p className="text-sm text-slate-600">Код отправлен на {maskedEmail}. Введите его и задайте новый пароль.</p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Код из письма</span>
          <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} name="code" required className="input w-full tracking-widest" placeholder="000000" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Новый пароль</span>
          <input type="password" name="password" required autoComplete="new-password" minLength={8} className="input w-full" />
        </label>
        <Submit label="Восстановить аккаунт" />
        {confirmState.error ? <p className="text-sm text-rose-600">{confirmState.error}</p> : null}
      </form>
    );
  }

  return (
    <form action={startAction} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-slate-600">
        Восстановление аккаунта {maskedEmail}. Мы отправим код подтверждения на исходный email.
        Права доступа к компаниям и клубам после восстановления нужно будет запросить заново.
      </p>
      <Submit label="Отправить код" />
      {startState.error ? <p className="text-sm text-rose-600">{startState.error}</p> : null}
    </form>
  );
}
