"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  createLegalEntity,
  updateLegalEntity,
  setLegalEntityActive,
  attachLegalEntityToClub,
  detachLegalEntityFromClub,
} from "../legal-entity-actions";
import { LEGAL_ENTITY_TYPES, legalEntityTypeLabel } from "@/lib/legal-entities";

type EntityView = {
  id: string;
  name: string;
  type: string;
  inn: string | null;
  kpp: string | null;
  bankName: string | null;
  bankBik: string | null;
  accountNumber: string | null;
  corrAccount: string | null;
  isActive: boolean;
  clubs: Array<{ clubId: string; clubName: string }>;
};
type ClubView = { id: string; name: string };

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="inline-flex items-center justify-center rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? "..." : label}
    </button>
  );
}
function Status({ state }: { state: State }) {
  if (state.ok) return <span className="text-xs text-emerald-700">Сохранено</span>;
  if (state.error) return <span className="text-xs text-rose-600">{state.error}</span>;
  return null;
}

const FIELDS: Array<{ name: string; label: string }> = [
  { name: "inn", label: "ИНН" },
  { name: "kpp", label: "КПП" },
  { name: "bankName", label: "Банк" },
  { name: "bankBik", label: "БИК" },
  { name: "accountNumber", label: "Расчётный счёт" },
  { name: "corrAccount", label: "Корр. счёт" },
];

export function LegalEntities({
  companyId,
  entities,
  clubs,
  canManage,
}: {
  companyId: string;
  entities: EntityView[];
  clubs: ClubView[];
  canManage: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Юридические лица</div>

      {entities.length === 0 ? (
        <div className="mb-3 text-sm text-slate-500">Юрлица не добавлены.</div>
      ) : (
        <div className="space-y-3">
          {entities.map((e) => (
            <div key={e.id} className={`rounded-md border p-3 ${e.isActive ? "border-slate-100 bg-slate-50" : "border-slate-200 bg-slate-100/60"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-900">{e.name}</span>
                <span className="inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">{legalEntityTypeLabel(e.type)}</span>
                {!e.isActive ? <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 ring-1 ring-inset ring-slate-200">Неактивно</span> : null}
                {e.inn ? <span className="text-xs text-slate-500">ИНН {e.inn}</span> : null}
                {e.kpp ? <span className="text-xs text-slate-500">КПП {e.kpp}</span> : null}
              </div>

              {/* Attached clubs */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {e.clubs.length === 0 ? (
                  <span className="text-xs text-slate-400">Не привязано к клубам</span>
                ) : (
                  e.clubs.map((c) => (
                    <span key={c.clubId} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">
                      {c.clubName}
                      {canManage ? (
                        <form action={detachLegalEntityFromClub} className="inline">
                          <input type="hidden" name="legalEntityId" value={e.id} />
                          <input type="hidden" name="clubId" value={c.clubId} />
                          <button type="submit" className="text-slate-400 hover:text-rose-600" title="Отвязать">×</button>
                        </form>
                      ) : null}
                    </span>
                  ))
                )}
              </div>

              {canManage ? (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {/* Attach to a club */}
                  <AttachForm entityId={e.id} clubs={clubs.filter((c) => !e.clubs.some((x) => x.clubId === c.id))} />
                  {/* Activate / deactivate */}
                  <form action={setLegalEntityActive}>
                    <input type="hidden" name="legalEntityId" value={e.id} />
                    <input type="hidden" name="active" value={e.isActive ? "false" : "true"} />
                    <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                      {e.isActive ? "Деактивировать" : "Активировать"}
                    </button>
                  </form>
                  <details className="w-full">
                    <summary className="cursor-pointer text-xs font-medium text-brand-600">Реквизиты / редактировать</summary>
                    <EditForm entity={e} />
                  </details>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canManage ? (
        <details className="mt-4 border-t border-slate-200 pt-4">
          <summary className="cursor-pointer text-sm font-medium text-brand-600">Добавить юрлицо</summary>
          <CreateForm companyId={companyId} />
        </details>
      ) : null}
    </div>
  );
}

function AttachForm({ entityId, clubs }: { entityId: string; clubs: ClubView[] }) {
  if (clubs.length === 0) return null;
  return (
    <form action={attachLegalEntityToClub} className="flex items-end gap-2">
      <input type="hidden" name="legalEntityId" value={entityId} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Привязать к клубу</span>
        <select name="clubId" defaultValue="" className="input" required>
          <option value="" disabled>Выберите клуб</option>
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Привязать</button>
    </form>
  );
}

function EditForm({ entity }: { entity: EntityView }) {
  const [state, action] = useFormState(updateLegalEntity, initial);
  return (
    <form action={action} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <input type="hidden" name="legalEntityId" value={entity.id} />
      <label className="block sm:col-span-2">
        <span className="mb-1 block text-xs font-medium text-slate-600">Название</span>
        <input name="name" defaultValue={entity.name} required className="input w-full" />
      </label>
      {FIELDS.map((f) => (
        <label key={f.name} className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">{f.label}</span>
          <input name={f.name} defaultValue={(entity as unknown as Record<string, string | null>)[f.name] ?? ""} className="input w-full" />
        </label>
      ))}
      <div className="flex items-center gap-2 sm:col-span-2">
        <Submit label="Сохранить" />
        <Status state={state} />
      </div>
    </form>
  );
}

function CreateForm({ companyId }: { companyId: string }) {
  const [state, action] = useFormState(createLegalEntity, initial);
  return (
    <form action={action} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      <input type="hidden" name="companyId" value={companyId} />
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Название</span>
        <input name="name" required className="input w-full" placeholder="ООО «Метрофитнес»" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Тип</span>
        <select name="type" defaultValue="ooo" className="input w-full">
          {LEGAL_ENTITY_TYPES.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
      </label>
      {FIELDS.map((f) => (
        <label key={f.name} className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">{f.label}</span>
          <input name={f.name} className="input w-full" />
        </label>
      ))}
      <div className="flex items-center gap-2 sm:col-span-2">
        <Submit label="Добавить" />
        <Status state={state} />
      </div>
    </form>
  );
}
