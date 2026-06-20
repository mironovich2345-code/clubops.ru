"use client";

import { useFormState, useFormStatus } from "react-dom";
import { verifyOtpAction, resendOtpAction, restartLoginAction } from "./actions";

type State = { ok: boolean; error?: string; info?: string };
const initial: State = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Проверка..." : "Подтвердить вход"}
    </button>
  );
}

function ResendButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-60">
      {pending ? "Отправка..." : "Отправить код повторно"}
    </button>
  );
}

export function VerifyForm({ next, sendError }: { next?: string; sendError?: boolean }) {
  const [verifyState, verifyAction] = useFormState(verifyOtpAction, initial);
  const [resendState, resendAction] = useFormState(resendOtpAction, initial);

  return (
    <div>
      <form action={verifyAction} className="space-y-3">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Код из письма</span>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            placeholder="______"
            className="input w-full text-center text-lg tracking-[0.5em]"
          />
        </label>
        <SubmitButton />
        {verifyState.error ? <p className="text-sm text-rose-600">{verifyState.error}</p> : null}
      </form>

      <div className="mt-4 flex items-center justify-between">
        <form action={resendAction}>
          <ResendButton />
        </form>
        <form action={restartLoginAction}>
          <button type="submit" className="text-sm text-slate-500 hover:text-slate-700">
            Вернуться к вводу пароля
          </button>
        </form>
      </div>
      {resendState.info ? <p className="mt-2 text-sm text-emerald-700">{resendState.info}</p> : null}
      {resendState.error ? <p className="mt-2 text-sm text-rose-600">{resendState.error}</p> : null}
      {sendError ? (
        <p className="mt-2 text-sm text-amber-700">Не удалось отправить код. Нажмите «Отправить код повторно».</p>
      ) : null}
    </div>
  );
}
