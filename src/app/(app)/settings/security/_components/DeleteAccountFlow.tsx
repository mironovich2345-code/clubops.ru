"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { deleteCurrentAccount } from "../delete-actions";

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function Submit({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
    >
      {pending ? "Удаление..." : label}
    </button>
  );
}

export function DeleteAccountFlow() {
  const [open, setOpen] = useState(false);
  const [state, action] = useFormState(deleteCurrentAccount, initial);
  const [confirmText, setConfirmText] = useState("");

  if (!open) {
    return (
      <div className="mt-8 rounded-lg border border-rose-200 bg-rose-50/40 p-5">
        <div className="text-sm font-semibold text-rose-800">Удаление аккаунта</div>
        <p className="mt-1 text-sm text-slate-600">
          Аккаунт будет отключён, все ваши сессии и доступы будут удалены. Финансовые
          записи компании сохранятся. Email освободится сразу. Это действие нельзя отменить.
        </p>
        <button
          onClick={() => setOpen(true)}
          className="mt-3 rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
        >
          Удалить аккаунт…
        </button>
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-lg border border-rose-300 bg-white p-5 shadow-sm">
      <div className="text-sm font-semibold text-rose-800">Удаление аккаунта</div>
      <p className="mt-2 text-sm text-slate-700">
        Аккаунт будет отключён, все ваши сессии и доступы будут удалены. Финансовые
        записи компании сохранятся. Это действие нельзя отменить.
      </p>
      <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
        <li>Доступ ко всем компаниям и клубам будет снят.</li>
        <li>Финансовая история сохраняется и остаётся привязанной к прежней записи.</li>
        <li>Email освобождается сразу и может быть использован для новой регистрации.</li>
      </ul>

      <form action={action} className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Текущий пароль</span>
          <input type="password" name="password" required autoComplete="current-password" className="input max-w-xs" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">
            Введите <span className="font-semibold text-rose-700">УДАЛИТЬ</span> для подтверждения
          </span>
          <input
            name="confirmation"
            required
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
            className="input max-w-xs tracking-widest"
            placeholder="УДАЛИТЬ"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Submit label="Удалить аккаунт" disabled={confirmText.trim() !== "УДАЛИТЬ"} />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs text-slate-500 underline"
          >
            Отмена
          </button>
          {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
        </div>
      </form>
    </div>
  );
}
