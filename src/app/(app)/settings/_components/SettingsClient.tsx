"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  createCompany,
  updateCompany,
  createClub,
  updateClub,
  archiveClub,
  restoreClub,
} from "../actions";
import { replaceClubLegalEntity } from "../legal-entity-actions";

type EntityOption = { id: string; name: string };
type ClubView = {
  id: string;
  name: string;
  city: string;
  isActive: boolean;
  oooId: string;
  oooName: string;
  ipId: string;
  ipName: string;
};
type CompanyView = {
  id: string;
  name: string;
  clubs: ClubView[];
  oooOptions: EntityOption[];
  ipOptions: EntityOption[];
};

type State = { ok: boolean; error?: string; needsConfirm?: boolean; warning?: string };
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
              <ClubEditor key={club.id} club={club} oooOptions={company.oooOptions} ipOptions={company.ipOptions} />
            ))}
          </div>
        )}

        {/* Add club — Сеть фиксирована текущей карточкой; ООО/ИП обязательны. */}
        <form action={clubAction} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="companyId" value={company.id} />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Клуб</span>
            <input name="name" required className="input w-full" placeholder="Чапаева" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Город</span>
            <input name="city" required className="input w-full" placeholder="Рязань" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">ООО клуба</span>
            <select name="oooId" defaultValue="" required className="input w-full" disabled={company.oooOptions.length === 0}>
              <option value="" disabled>{company.oooOptions.length === 0 ? "Нет активных ООО" : "Выберите ООО"}</option>
              {company.oooOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">ИП клуба</span>
            <select name="ipId" defaultValue="" required className="input w-full" disabled={company.ipOptions.length === 0}>
              <option value="" disabled>{company.ipOptions.length === 0 ? "Нет активных ИП" : "Выберите ИП"}</option>
              {company.ipOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Submit label="Добавить клуб" />
            <Status state={clubState} />
          </div>
          {company.oooOptions.length === 0 || company.ipOptions.length === 0 ? (
            <div className="text-xs text-amber-700 sm:col-span-2">
              Для создания клуба нужно хотя бы одно активное ООО и одно активное ИП в этой сети. Добавьте юрлица выше.
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function ClubEditor({ club, oooOptions, ipOptions }: { club: ClubView; oooOptions: EntityOption[]; ipOptions: EntityOption[] }) {
  const [state, action] = useFormState(updateClub, initial);

  return (
    <div
      className={`rounded-md border p-3 ${
        club.isActive ? "border-slate-100 bg-slate-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        {club.isActive ? (
          <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
            Активен
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
            В архиве
          </span>
        )}
      </div>

      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="clubId" value={club.id} />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Название клуба</span>
          <input name="name" defaultValue={club.name} required className="input" disabled={!club.isActive} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Город</span>
          <input name="city" defaultValue={club.city} className="input" disabled={!club.isActive} />
        </label>
        {club.isActive ? <Submit label="Сохранить" /> : null}
        <Status state={state} />
      </form>

      {club.isActive ? (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
          <ReplaceEntityForm clubId={club.id} type="ooo" field="ООО клуба" currentId={club.oooId} currentName={club.oooName} options={oooOptions} />
          <ReplaceEntityForm clubId={club.id} type="ip" field="ИП клуба" currentId={club.ipId} currentName={club.ipName} options={ipOptions} />
        </div>
      ) : null}

      <div className="mt-2">
        {club.isActive ? <ArchiveClubForm club={club} /> : <RestoreClubForm club={club} />}
      </div>
    </div>
  );
}

// Replace a single active ООО or ИП for a club. Changing one type never touches
// the other (separate forms / separate server calls).
function ReplaceEntityForm({
  clubId,
  type,
  field,
  currentId,
  currentName,
  options,
}: {
  clubId: string;
  type: "ooo" | "ip";
  field: string;
  currentId: string;
  currentName: string;
  options: EntityOption[];
}) {
  const [state, action] = useFormState(replaceClubLegalEntity, initial);
  return (
    <form action={action} className="rounded-md border border-slate-200 bg-white p-3">
      <input type="hidden" name="clubId" value={clubId} />
      <input type="hidden" name="type" value={type} />
      <div className="mb-1 text-xs font-medium text-slate-600">{field}</div>
      <div className="mb-2 text-xs text-slate-500">
        Текущее: {currentName ? <span className="font-medium text-slate-800">{currentName}</span> : "Не назначено"}
      </div>
      <div className="flex items-end gap-2">
        <select name="legalEntityId" defaultValue={currentId} className="input w-full">
          <option value="">Не назначено</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <MiniSubmit label="Сохранить" tone="emerald" />
      </div>
      {state.error ? <div className="mt-1 text-xs text-rose-600">{state.error}</div> : null}
      {state.ok ? <div className="mt-1 text-xs text-emerald-700">Сохранено</div> : null}
    </form>
  );
}

function MiniSubmit({ label, tone }: { label: string; tone: "amber" | "emerald" }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "amber"
      ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
      : "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-60 ${cls}`}
    >
      {pending ? "..." : label}
    </button>
  );
}

function ArchiveClubForm({ club }: { club: ClubView }) {
  const [state, action] = useFormState(archiveClub, initial);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        // Confirm intent; the server separately requires confirm=true to
        // archive the last active club, surfaced via state.needsConfirm.
        if (!window.confirm(`Архивировать клуб «${club.name}»? Он будет скрыт из списков.`)) {
          e.preventDefault();
        }
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="clubId" value={club.id} />
      {state.needsConfirm ? <input type="hidden" name="confirm" value="true" /> : null}
      <MiniSubmit label={state.needsConfirm ? "Подтвердить архивацию" : "Архивировать"} tone="amber" />
      {state.error ? (
        <span className={`text-xs ${state.needsConfirm ? "text-amber-700" : "text-rose-600"}`}>
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

function RestoreClubForm({ club }: { club: ClubView }) {
  const [state, action] = useFormState(restoreClub, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="clubId" value={club.id} />
      <MiniSubmit label="Восстановить" tone="emerald" />
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
      {state.warning ? <span className="w-full text-xs text-amber-700">{state.warning}</span> : null}
    </form>
  );
}
