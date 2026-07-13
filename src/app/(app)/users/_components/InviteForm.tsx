"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { createInvite } from "../actions";

type RoleOption = { value: string; label: string };
type ClubOption = { id: string; name: string; city: string };

type FormState = {
  ok: boolean;
  error?: string;
  outcome?: "granted" | "pending";
  notice?: string;
  emailWarning?: boolean;
};
const initialState: FormState = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Создание..." : "Создать приглашение"}
    </button>
  );
}

export function InviteForm({
  roles,
  clubs,
  companyName,
}: {
  roles: RoleOption[];
  clubs: ClubOption[];
  companyName: string;
}) {
  const [state, formAction] = useFormState(createInvite, initialState);
  const [role, setRole] = useState("");

  const needsClub = role === "manager";

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 text-sm font-semibold text-slate-700">Пригласить пользователя</div>

      <form action={formAction} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Компания">
          <input
            value={companyName}
            disabled
            className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            name="email"
            required
            placeholder="user@example.com"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </Field>

        <Field label="Роль">
          <select
            name="role"
            required
            defaultValue=""
            onChange={(e) => setRole(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="" disabled>
              Выберите роль
            </option>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label={needsClub ? "Клуб" : "Клуб (для менеджера)"}>
          <select
            name="clubId"
            defaultValue=""
            disabled={!needsClub}
            required={needsClub}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-400"
          >
            <option value="" disabled>
              Выберите клуб
            </option>
            {clubs.map((club) => (
              <option key={club.id} value={club.id}>
                {club.name} — {club.city}
              </option>
            ))}
          </select>
        </Field>

        <div className="md:col-span-2 flex items-center justify-between gap-3">
          {state.error ? (
            <span className="text-sm text-rose-600">{state.error}</span>
          ) : (
            <span />
          )}
          <SubmitButton />
        </div>
      </form>

      {state.ok && state.notice ? (
        <div
          className={`mt-4 rounded-md p-3 text-sm ring-1 ring-inset ${
            state.emailWarning
              ? "bg-amber-50 text-amber-800 ring-amber-200"
              : "bg-emerald-50 text-emerald-800 ring-emerald-200"
          }`}
        >
          <span className="font-medium">
            {state.outcome === "granted" ? "Доступ предоставлен. " : ""}
          </span>
          {state.notice}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
