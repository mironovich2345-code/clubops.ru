"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { startSelfDeletion, confirmSelfDeletion, resendSelfDeletionOtp } from "../delete-actions";

type State = { ok: boolean; stage?: "password" | "otp" | "done"; error?: string };
const initial: State = { ok: false, stage: "password" };

function Submit({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${danger ? "bg-rose-600 text-white hover:bg-rose-700" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
    >
      {pending ? "..." : label}
    </button>
  );
}

export function DeleteAccountFlow() {
  const [open, setOpen] = useState(false);
  const [pwState, pwAction] = useFormState(startSelfDeletion, initial);
  const [otpState, otpAction] = useFormState(confirmSelfDeletion, initial);

  // Advance to the OTP step once the password step succeeds.
  const stage = otpState.stage ?? (pwState.ok ? "otp" : pwState.stage ?? "password");

  if (!open) {
    return (
      <div className="mt-8 rounded-lg border border-rose-200 bg-rose-50/40 p-5">
        <div className="text-sm font-semibold text-rose-800">Удаление аккаунта</div>
        <p className="mt-1 text-sm text-slate-600">
          Аккаунт будет удалён, доступ ко всем компаниям и клубам снят. Финансовая история сохранится.
          Email освободится сразу. Восстановление доступно 30 дней.
        </p>
        <button onClick={() => setOpen(true)} className="mt-3 rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100">
          Удалить аккаунт…
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-lg border border-rose-300 bg-white p-5 shadow-sm">
      <div className="text-sm font-semibold text-rose-800">Удаление аккаунта</div>
      <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
        <li>Доступ ко всем компаниям и клубам будет снят.</li>
        <li>Финансовая история сохраняется и остаётся привязанной к прежней записи.</li>
        <li>Email освобождается сразу и может быть использован для новой регистрации.</li>
        <li>Восстановление возможно в течение 30 дней по ссылке из письма.</li>
        <li>Права доступа после восстановления не возвращаются автоматически.</li>
      </ul>

      {stage !== "otp" ? (
        <form action={pwAction} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Текущий пароль</span>
            <input type="password" name="password" required autoComplete="current-password" className="input" />
          </label>
          <Submit label="Продолжить" danger />
          {pwState.error ? <span className="text-xs text-rose-600">{pwState.error}</span> : null}
          <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500 underline">Отмена</button>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form action={otpAction} className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Код из письма</span>
              <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} name="code" required className="input tracking-widest" placeholder="000000" />
            </label>
            <Submit label="Удалить аккаунт" danger />
            {otpState.error ? <span className="text-xs text-rose-600">{otpState.error}</span> : null}
          </form>
          <form action={resendSelfDeletionOtp}>
            <button type="submit" className="text-xs text-slate-500 underline">Отправить код повторно</button>
          </form>
        </div>
      )}
    </div>
  );
}
