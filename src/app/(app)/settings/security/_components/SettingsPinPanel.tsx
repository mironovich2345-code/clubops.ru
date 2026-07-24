"use client";

import { useFormState, useFormStatus } from "react-dom";
import { setSettingsPinAction, verifySettingsPinAction, clearSettingsPinAction, type PinActionState } from "../../pin-actions";

const initial: PinActionState = { ok: false };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "…" : label}
    </button>
  );
}

function SetPinForm({ change }: { change: boolean }) {
  const [state, action] = useFormState(setSettingsPinAction, initial);
  return (
    <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
      {change ? (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Текущий ПИН</span>
          <input name="currentPin" type="password" inputMode="numeric" autoComplete="off" className="input w-36" />
        </label>
      ) : null}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Новый ПИН (4–32 цифры)</span>
        <input name="newPin" type="password" inputMode="numeric" autoComplete="off" required className="input w-36" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Повторите ПИН</span>
        <input name="confirmPin" type="password" inputMode="numeric" autoComplete="off" required className="input w-36" />
      </label>
      <Submit label={change ? "Сменить ПИН" : "Задать ПИН"} />
      {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
    </form>
  );
}

function VerifyForm() {
  const [state, action] = useFormState(verifySettingsPinAction, initial);
  return (
    <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">ПИН настроек</span>
        <input name="pin" type="password" inputMode="numeric" autoComplete="off" required className="input w-36" />
      </label>
      <Submit label="Разблокировать" />
      {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
    </form>
  );
}

export function SettingsPinPanel({
  isOwner,
  configured,
  isPrimaryOwner,
  verified,
  lockedUntilIso,
}: {
  isOwner: boolean;
  configured: boolean;
  isPrimaryOwner: boolean;
  verified: boolean;
  lockedUntilIso: string | null;
}) {
  if (!isOwner) return null;
  const locked = lockedUntilIso != null && new Date(lockedUntilIso).getTime() > Date.now();

  return (
    <div className="mt-8 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-semibold text-slate-700">ПИН критических настроек компании</div>
      <p className="mt-1 text-xs text-slate-500">
        Отдельный ПИН (не пароль аккаунта) для защиты чувствительных настроек: подключения ОФД, юрлица, приглашения собственников и т. п. После верного ПИН доступ открыт на 15 минут.
      </p>

      {!configured ? (
        isPrimaryOwner ? (
          <>
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">ПИН ещё не задан. Задайте его, чтобы включить защиту.</div>
            <SetPinForm change={false} />
          </>
        ) : (
          <div className="mt-3 text-sm text-slate-500">ПИН задаёт первичный собственник компании.</div>
        )
      ) : locked ? (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          Доступ временно заблокирован из-за неверных попыток. Повторите позже.
        </div>
      ) : verified ? (
        <>
          <div className="mt-3 flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Критические настройки разблокированы</span>
            <form action={clearSettingsPinAction}>
              <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Заблокировать снова</button>
            </form>
          </div>
          {isPrimaryOwner ? <SetPinForm change={true} /> : null}
        </>
      ) : (
        <>
          <VerifyForm />
          {isPrimaryOwner ? (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="text-xs font-medium text-slate-600">Сменить ПИН</div>
              <SetPinForm change={true} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
