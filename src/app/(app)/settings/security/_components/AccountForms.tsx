"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  updateProfile,
  startPasswordChange, confirmPasswordChange, resendPasswordOtp,
  startEmailChange, confirmEmailChangeCurrent, confirmEmailChangeNew,
  resendEmailCurrentOtp, resendEmailNewOtp, cancelEmailChange,
} from "../account-actions";

function Btn({ idle, busy, danger }: { idle: string; busy?: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${danger ? "bg-rose-600 text-white hover:bg-rose-700" : "bg-brand-600 text-white hover:bg-brand-700"}`}
    >
      {pending ? busy ?? "..." : idle}
    </button>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  );
}

// ---- Personal data ---------------------------------------------------------

export function PersonalDataForm({ firstName, lastName, updatedAt }: { firstName: string; lastName: string; updatedAt: string }) {
  const [state, action] = useFormState(updateProfile, { ok: false } as { ok: boolean; error?: string });
  return (
    <Card title="Личные данные">
      <form action={action} className="mt-3 grid max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">
        <input type="hidden" name="updatedAt" value={updatedAt} />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Имя</span>
          <input name="firstName" defaultValue={firstName} required maxLength={80} className="input" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Фамилия</span>
          <input name="lastName" defaultValue={lastName} required maxLength={80} className="input" />
        </label>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <Btn idle="Сохранить изменения" busy="Сохранение..." />
          {state.ok ? <span className="text-xs text-emerald-700">Имя и фамилия обновлены.</span> : null}
          {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
        </div>
      </form>
    </Card>
  );
}

// ---- Password change -------------------------------------------------------

type PwState = { ok: boolean; stage?: "form" | "otp" | "done"; error?: string };
const pwInit: PwState = { ok: false, stage: "form" };

export function PasswordChangeFlow({ emailEnabled, maskedEmail }: { emailEnabled: boolean; maskedEmail: string }) {
  const [start, startAction] = useFormState(startPasswordChange, pwInit);
  const [done, confirmAction] = useFormState(confirmPasswordChange, pwInit);
  // Keep the entered values so step 2 can resubmit them (never stored server-side).
  const [cur, setCur] = useState(""); const [np, setNp] = useState(""); const [cf, setCf] = useState("");

  const stage = done.stage === "done" ? "done" : done.ok || start.ok ? "otp" : start.stage ?? "form";

  if (!emailEnabled) {
    return <Card title="Изменение пароля"><p className="mt-2 text-sm text-slate-500">Изменение пароля недоступно: почтовый сервис не настроен.</p></Card>;
  }
  if (stage === "done") {
    return <Card title="Изменение пароля"><p className="mt-2 text-sm text-emerald-700">Пароль изменён. Другие сессии завершены.</p></Card>;
  }

  return (
    <Card title="Изменение пароля">
      {stage !== "otp" ? (
        <form action={startAction} className="mt-3 max-w-sm space-y-3">
          <Field label="Текущий пароль"><input type="password" name="currentPassword" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" className="input" /></Field>
          <Field label="Новый пароль"><input type="password" name="newPassword" value={np} onChange={(e) => setNp(e.target.value)} required autoComplete="new-password" className="input" /></Field>
          <Field label="Повторите новый пароль"><input type="password" name="confirmPassword" value={cf} onChange={(e) => setCf(e.target.value)} required autoComplete="new-password" className="input" /></Field>
          <div className="flex items-center gap-3"><Btn idle="Получить код" busy="Отправка..." />{start.error ? <span className="text-xs text-rose-600">{start.error}</span> : null}</div>
        </form>
      ) : (
        <form action={confirmAction} className="mt-3 max-w-sm space-y-3">
          <input type="hidden" name="currentPassword" value={cur} />
          <input type="hidden" name="newPassword" value={np} />
          <input type="hidden" name="confirmPassword" value={cf} />
          <p className="text-xs text-slate-500">Код отправлен на текущую почту {maskedEmail}.</p>
          <Field label="Код подтверждения"><input inputMode="numeric" pattern="\d{6}" maxLength={6} name="code" required className="input tracking-widest" placeholder="000000" /></Field>
          <div className="flex flex-wrap items-center gap-3">
            <Btn idle="Изменить пароль" busy="Изменение..." danger />
            {done.error ? <span className="text-xs text-rose-600">{done.error}</span> : null}
          </div>
          <ResendButton action={resendPasswordOtp} />
        </form>
      )}
    </Card>
  );
}

// ---- Email change ----------------------------------------------------------

type EmState = { ok: boolean; stage?: "form" | "otp_current" | "otp_new" | "done"; error?: string; maskedNew?: string };
const emInit: EmState = { ok: false, stage: "form" };

export function EmailChangeFlow({ emailEnabled, maskedEmail }: { emailEnabled: boolean; maskedEmail: string }) {
  const [s1, a1] = useFormState(startEmailChange, emInit);
  const [s2, a2] = useFormState(confirmEmailChangeCurrent, emInit);
  const [s3, a3] = useFormState(confirmEmailChangeNew, emInit);

  const stage: EmState["stage"] =
    s3.stage === "done" ? "done"
    : s2.ok || s3.stage === "otp_new" || s3.error ? "otp_new"
    : s1.ok || s2.stage === "otp_current" || s2.error ? "otp_current"
    : s1.stage ?? "form";
  const maskedNew = s2.maskedNew ?? "новую почту";

  if (!emailEnabled) {
    return <Card title="Изменение email"><p className="mt-2 text-sm text-slate-500">Изменение email недоступно: почтовый сервис не настроен.</p></Card>;
  }
  if (stage === "done") {
    return <Card title="Изменение email"><p className="mt-2 text-sm text-emerald-700">Email изменён. Другие сессии завершены.</p></Card>;
  }

  return (
    <Card title="Изменение email">
      {stage === "form" ? (
        <form action={a1} className="mt-3 max-w-sm space-y-3">
          <Field label="Текущий пароль"><input type="password" name="currentPassword" required autoComplete="current-password" className="input" /></Field>
          <Field label="Новый email"><input type="email" name="newEmail" required className="input" /></Field>
          <div className="flex items-center gap-3"><Btn idle="Получить код" busy="Отправка..." />{s1.error ? <span className="text-xs text-rose-600">{s1.error}</span> : null}</div>
        </form>
      ) : stage === "otp_current" ? (
        <form action={a2} className="mt-3 max-w-sm space-y-3">
          <p className="text-xs text-slate-500">Код отправлен на текущую почту {maskedEmail}.</p>
          <Field label="Код с текущей почты"><input inputMode="numeric" pattern="\d{6}" maxLength={6} name="code" required className="input tracking-widest" placeholder="000000" /></Field>
          <div className="flex flex-wrap items-center gap-3"><Btn idle="Подтвердить текущую почту" busy="..." />{s2.error ? <span className="text-xs text-rose-600">{s2.error}</span> : null}</div>
          <ResendButton action={resendEmailCurrentOtp} />
          <CancelButton />
        </form>
      ) : (
        <form action={a3} className="mt-3 max-w-sm space-y-3">
          <p className="text-xs text-emerald-700">Текущая почта подтверждена. Код отправлен на {maskedNew}.</p>
          <Field label="Код с новой почты"><input inputMode="numeric" pattern="\d{6}" maxLength={6} name="code" required className="input tracking-widest" placeholder="000000" /></Field>
          <div className="flex flex-wrap items-center gap-3"><Btn idle="Изменить email" busy="Изменение..." danger />{s3.error ? <span className="text-xs text-rose-600">{s3.error}</span> : null}</div>
          <ResendButton action={resendEmailNewOtp} />
          <CancelButton />
        </form>
      )}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
function ResendButton({ action }: { action: () => Promise<void> }) {
  return (
    <form action={action}>
      <button type="submit" className="text-xs text-slate-500 underline">Отправить код повторно</button>
    </form>
  );
}
function CancelButton() {
  return (
    <form action={cancelEmailChange}>
      <button type="submit" className="text-xs text-slate-400 underline">Отменить</button>
    </form>
  );
}
