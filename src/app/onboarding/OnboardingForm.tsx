"use client";

import { useFormState, useFormStatus } from "react-dom";
import { completeOnboarding } from "./actions";

type FormState = { ok: boolean; error?: string };
const initialState: FormState = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Создание..." : "Создать и продолжить"}
    </button>
  );
}

export function OnboardingForm() {
  const [state, formAction] = useFormState(completeOnboarding, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <div className="mb-2 text-sm font-semibold text-slate-700">Шаг 1. Компания</div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Название компании</span>
          <input name="companyName" required className="input" placeholder="ООО «Мой бизнес»" />
        </label>
      </div>

      <div>
        <div className="mb-2 text-sm font-semibold text-slate-700">Шаг 2. Первый клуб</div>
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Название клуба</span>
            <input name="clubName" required className="input" placeholder="Фитнес-клуб на Ленина" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Город</span>
            <input name="city" className="input" placeholder="Москва" />
          </label>
        </div>
      </div>

      {state.error ? (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
          {state.error}
        </div>
      ) : null}

      <SubmitButton />
    </form>
  );
}
