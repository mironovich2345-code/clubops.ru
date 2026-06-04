"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createCompany, updateCompany, createClub, updateClub } from "../actions";

type ClubView = { id: string; name: string; city: string };
type CompanyView = { id: string; name: string; clubs: ClubView[] };

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Сохранение..." : label}
    </button>
  );
}

function Status({ state }: { state: State }) {
  if (state.ok) return <span className="text-sm text-emerald-700">Сохранено</span>;
  if (state.error) return <span className="text-sm text-rose-600">{state.error}</span>;
  return null;
}

export function AddCompanyForm() {
  const [state, action] = useFormState(createCompany, initial);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Добавить организацию</div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Название организации</span>
          <input name="name" required className="input" placeholder="ООО «Новая компания»" />
        </label>
        <Submit label="Сохранить" />
        <Status state={state} />
      </form>
    </div>
  );
}

export function CompanyEditor({ company }: { company: CompanyView }) {
  const [nameState, nameAction] = useFormState(updateCompany, initial);
  const [clubState, clubAction] = useFormState(createClub, initial);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      {/* Edit company name */}
      <form action={nameAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="companyId" value={company.id} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Название организации</span>
          <input name="name" defaultValue={company.name} required className="input" />
        </label>
        <Submit label="Сохранить" />
        <Status state={nameState} />
      </form>

      {/* Clubs */}
      <div className="mt-5 border-t border-slate-200 pt-4">
        <div className="mb-3 text-sm font-medium text-slate-700">Клубы</div>
        {company.clubs.length === 0 ? (
          <div className="mb-3 text-sm text-slate-500">Пока нет клубов.</div>
        ) : (
          <div className="space-y-3">
            {company.clubs.map((club) => (
              <ClubEditor key={club.id} club={club} />
            ))}
          </div>
        )}

        {/* Add club */}
        <form action={clubAction} className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="companyId" value={company.id} />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Название клуба</span>
            <input name="name" required className="input" placeholder="Новый клуб" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Город</span>
            <input name="city" className="input" placeholder="Москва" />
          </label>
          <Submit label="Добавить клуб" />
          <Status state={clubState} />
        </form>
      </div>
    </div>
  );
}

function ClubEditor({ club }: { club: ClubView }) {
  const [state, action] = useFormState(updateClub, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border border-slate-100 bg-slate-50 p-3">
      <input type="hidden" name="clubId" value={club.id} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Название клуба</span>
        <input name="name" defaultValue={club.name} required className="input" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Город</span>
        <input name="city" defaultValue={club.city} className="input" />
      </label>
      <Submit label="Сохранить" />
      <Status state={state} />
    </form>
  );
}
