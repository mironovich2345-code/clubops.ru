"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createLegalEntity,
  updateLegalEntity,
  setLegalEntityActive,
  attachLegalEntityToClub,
  detachLegalEntityFromClub,
} from "../legal-entity-actions";
import { LEGAL_ENTITY_TYPES, legalEntityTypeLabel, normalizeEntityType } from "@/lib/legal-entities";
import { legalEntityFieldWarning } from "@/lib/legal-entity-format";

type EntityView = {
  id: string;
  name: string;
  type: string;
  fullName: string | null;
  shortName: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankBik: string | null;
  accountNumber: string | null;
  corrAccount: string | null;
  directorName: string | null;
  comment: string | null;
  isActive: boolean;
  clubs: Array<{ clubId: string; clubName: string }>;
};
type ClubView = { id: string; name: string };

type State = { ok: boolean; error?: string };
const initial: State = { ok: false };

// Profile sections (Часть 2). `validate` fields show a non-blocking format warning.
const SECTIONS: Array<{ title: string; fields: Array<{ name: string; label: string; validate?: boolean }> }> = [
  { title: "Общая информация", fields: [{ name: "fullName", label: "Полное наименование" }, { name: "shortName", label: "Краткое наименование" }] },
  { title: "Реквизиты", fields: [{ name: "inn", label: "ИНН", validate: true }, { name: "kpp", label: "КПП", validate: true }, { name: "ogrn", label: "ОГРН" }, { name: "legalAddress", label: "Юридический адрес" }] },
  { title: "Контакты", fields: [{ name: "phone", label: "Телефон" }, { name: "email", label: "Email" }] },
  { title: "Банк", fields: [{ name: "bankName", label: "Банк" }, { name: "bankBik", label: "БИК", validate: true }, { name: "accountNumber", label: "Расчётный счёт", validate: true }, { name: "corrAccount", label: "Корр. счёт", validate: true }] },
  { title: "Ответственное лицо", fields: [{ name: "directorName", label: "Руководитель" }] },
  { title: "Прочее", fields: [{ name: "comment", label: "Комментарий" }] },
];

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

function ProfileInput({ name, label, defaultValue, validate }: { name: string; label: string; defaultValue: string; validate?: boolean }) {
  const [v, setV] = useState(defaultValue);
  const warning = validate ? legalEntityFieldWarning(name, v) : null;
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <input name={name} value={v} onChange={(e) => setV(e.target.value)} className="input w-full" />
      {warning ? <span className="mt-1 block text-xs text-amber-700">{warning}</span> : null}
    </label>
  );
}

function SectionedFields({ entity }: { entity?: EntityView }) {
  const val = (k: string) => (entity ? (entity as unknown as Record<string, string | null>)[k] ?? "" : "");
  return (
    <>
      {SECTIONS.map((s) => (
        <div key={s.title} className="sm:col-span-2">
          <div className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{s.title}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {s.fields.map((f) => (
              <ProfileInput key={f.name} name={f.name} label={f.label} defaultValue={val(f.name)} validate={f.validate} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export function LegalEntities({
  companyId,
  entities,
  clubs,
  canManage,
  canAssign = canManage,
}: {
  companyId: string;
  entities: EntityView[];
  clubs: ClubView[];
  canManage: boolean;
  // canManage: create/edit/activate entity profiles (owner or GD).
  // canAssign: attach/detach entity to/from a club (owner only — Part 3).
  canAssign?: boolean;
}) {
  // Rule (max 1 active ООО + 1 active ИП per club): which active types each club
  // already uses, so the attach dropdown can hide conflicting clubs.
  const activeTypeByClub = new Map<string, Set<string>>();
  for (const ent of entities) {
    if (!ent.isActive) continue;
    const t = normalizeEntityType(ent.type);
    if (!t) continue;
    for (const c of ent.clubs) {
      const set = activeTypeByClub.get(c.clubId) ?? new Set<string>();
      set.add(t);
      activeTypeByClub.set(c.clubId, set);
    }
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-slate-700">Юридические лица</div>
      <div className="mb-3 text-xs text-slate-500">Допустимо одно активное ООО и одно активное ИП на клуб.</div>

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
                {e.directorName ? <span className="text-xs text-slate-500">Рук.: {e.directorName}</span> : null}
              </div>

              {/* Attached clubs */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {e.clubs.length === 0 ? (
                  <span className="text-xs text-slate-400">Не привязано к клубам</span>
                ) : (
                  e.clubs.map((c) => (
                    <span key={c.clubId} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">
                      {c.clubName}
                      {canAssign ? (
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

              {canAssign ? (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <AttachForm
                    entityId={e.id}
                    clubs={clubs.filter((c) => {
                      if (e.clubs.some((x) => x.clubId === c.id)) return false; // already attached here
                      // An active entity can't attach to a club that already has an active same-type entity.
                      const t = normalizeEntityType(e.type);
                      return !(e.isActive && t && activeTypeByClub.get(c.id)?.has(t));
                    })}
                  />
                  </div>
              ) : null}
              {canManage ? (
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  <form action={setLegalEntityActive}>
                    <input type="hidden" name="legalEntityId" value={e.id} />
                    <input type="hidden" name="active" value={e.isActive ? "false" : "true"} />
                    <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                      {e.isActive ? "Деактивировать" : "Активировать"}
                    </button>
                  </form>
                  <details className="w-full">
                    <summary className="cursor-pointer text-xs font-medium text-brand-600">Профиль / редактировать</summary>
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
        <span className="mb-1 block text-xs font-medium text-slate-600">Название (для списков)</span>
        <input name="name" defaultValue={entity.name} required className="input w-full" />
      </label>
      <div className="sm:col-span-2 text-xs text-slate-500">Тип: <span className="font-medium text-slate-700">{legalEntityTypeLabel(entity.type)}</span></div>
      <SectionedFields entity={entity} />
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
        <span className="mb-1 block text-xs font-medium text-slate-600">Название (для списков)</span>
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
      <SectionedFields />
      <div className="flex items-center gap-2 sm:col-span-2">
        <Submit label="Добавить" />
        <Status state={state} />
      </div>
    </form>
  );
}
