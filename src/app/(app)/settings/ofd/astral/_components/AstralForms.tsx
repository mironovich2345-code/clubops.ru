"use client";

import { useFormState, useFormStatus } from "react-dom";
import { saveAstralApiKey, testAstralConnection, type AstralState } from "../actions";

const initial: AstralState = { ok: false };

function Submit({ label, variant = "primary" }: { label: string; variant?: "primary" | "neutral" }) {
  const { pending } = useFormStatus();
  const cls = variant === "primary"
    ? "bg-brand-600 text-white hover:bg-brand-700"
    : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button type="submit" disabled={pending} className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium shadow-sm disabled:opacity-60 ${cls}`}>
      {pending ? "…" : label}
    </button>
  );
}

export function AstralApiKeyForm({ hasKey }: { hasKey: boolean }) {
  const [state, action] = useFormState(saveAstralApiKey, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="block grow">
        <span className="mb-1 block text-xs font-medium text-slate-600">API-ключ Астрал.ОФД</span>
        <input
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder={hasKey ? "•••••••• (сохранён — оставьте пустым, чтобы не менять)" : "Вставьте API-ключ"}
          className="input w-full"
        />
      </label>
      <Submit label="Сохранить ключ" />
      {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-rose-600">{state.error}</span> : null}
    </form>
  );
}

export function AstralTestConnection() {
  const [state, action] = useFormState(testAstralConnection, initial);
  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-3">
      <Submit label="Проверить подключение" variant="neutral" />
      {state.ok ? <span className="text-sm text-emerald-700">{state.notice}</span> : state.error ? <span className="text-sm text-amber-700">{state.error}</span> : null}
    </form>
  );
}
