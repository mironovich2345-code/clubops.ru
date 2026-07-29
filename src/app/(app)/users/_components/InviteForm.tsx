"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { buttonClass } from "@/components/mobile/buttons";
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

// Shared field chrome — theme-aware so nothing renders white in dark mode (spec §12).
const CONTROL =
  "min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${buttonClass({ variant: "primary", size: "cta" })} w-full sm:w-auto`}>
      {pending ? "Создание..." : "Создать приглашение"}
    </button>
  );
}

export function InviteForm({
  roles,
  clubs,
  companyName,
  clubScopedRoles,
}: {
  roles: RoleOption[];
  clubs: ClubOption[];
  companyName: string;
  /** Source of truth from the server (mirrors isClubScopedRole). A role listed
   *  here needs exactly one club; every other invitable role is company-wide. */
  clubScopedRoles: string[];
}) {
  const [state, formAction] = useFormState(createInvite, initialState);
  const [role, setRole] = useState("");

  const roleChosen = role !== "";
  const isClubScoped = clubScopedRoles.includes(role);
  const noClubs = clubs.length === 0;

  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">Пригласить пользователя</div>

      <form action={formAction} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Компания">
          <input value={companyName} disabled className={`${CONTROL} bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-400`} />
        </Field>

        <Field label="Email">
          <input type="email" name="email" required placeholder="user@example.com" className={CONTROL} />
        </Field>

        <Field label="Роль">
          <select
            name="role"
            required
            defaultValue=""
            onChange={(e) => setRole(e.target.value)}
            className={CONTROL}
          >
            <option value="" disabled>Выберите роль</option>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </Field>

        {/* Access scope control — driven by the role's actual scope (spec §12), NOT a
            hardcoded "для менеджера". Club-scoped role → enabled required club select;
            company-scoped role → explicit "вся компания" note; no role yet → hint. */}
        <Field label="Область доступа">
          {!roleChosen ? (
            <div className="flex min-h-[44px] items-center rounded-md border border-dashed border-slate-300 px-3 text-sm text-slate-400 dark:border-slate-700 dark:text-slate-500">
              Сначала выберите роль
            </div>
          ) : isClubScoped ? (
            noClubs ? (
              <div className="flex min-h-[44px] items-center rounded-md border border-amber-300 bg-amber-50 px-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                Нет активных клубов для назначения
              </div>
            ) : (
              <>
                <select name="clubId" defaultValue="" required className={CONTROL}>
                  <option value="" disabled>Выберите клуб</option>
                  {clubs.map((club) => (
                    <option key={club.id} value={club.id}>{club.name} — {club.city}</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-slate-400 dark:text-slate-500">Управляющий закрепляется за одним клубом</span>
              </>
            )
          ) : (
            <div className="flex min-h-[44px] items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
              <span aria-hidden>🏢</span> Доступ ко всей компании
            </div>
          )}
        </Field>

        <div className="md:col-span-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {state.error ? <span className="text-sm text-rose-600 dark:text-rose-400">{state.error}</span> : <span className="hidden sm:block" />}
          <SubmitButton />
        </div>
      </form>

      {state.ok && state.notice ? (
        <div
          className={`mt-4 rounded-md p-3 text-sm ring-1 ring-inset ${
            state.emailWarning
              ? "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20"
              : "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/20"
          }`}
        >
          <span className="font-medium">{state.outcome === "granted" ? "Доступ предоставлен. " : ""}</span>
          {state.notice}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      {children}
    </label>
  );
}
