"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  loadAstralOrganizations,
  selectAstralOrganization,
  loadAstralOutlets,
  loadAstralKkts,
  bindAstralKkt,
  unbindAstralKkt,
  type StepOrgsState,
  type StepOutletsState,
  type StepKktsState,
  type StepMutState,
} from "../steps-actions";

type LE = { id: string; name: string };
type Club = { id: string; name: string };
type BoundKkt = { fnNumber: string; label: string; clubName: string; legalName: string };

const orgs0: StepOrgsState = { ok: false };
const outlets0: StepOutletsState = { ok: false };
const kkts0: StepKktsState = { ok: false };
const mut0: StepMutState = { ok: false };

function Btn({ label, variant = "neutral" }: { label: string; variant?: "primary" | "neutral" }) {
  const { pending } = useFormStatus();
  const cls = variant === "primary" ? "bg-brand-600 text-white hover:bg-brand-700" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button type="submit" disabled={pending} className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm disabled:opacity-60 ${cls}`}>
      {pending ? "…" : label}
    </button>
  );
}

function Msg({ state }: { state: { ok: boolean; error?: string; notice?: string } }) {
  if (state.ok && state.notice) return <span className="text-sm text-emerald-700">{state.notice}</span>;
  if (!state.ok && state.error) return <span className="text-sm text-amber-700">{state.error}</span>;
  return null;
}

// ---- Step 2: organization → LegalEntity --------------------------------------

export function AstralOrgStep({ legalEntities, boundOrganizationId, boundLegalEntityId }: { legalEntities: LE[]; boundOrganizationId: string | null; boundLegalEntityId: string | null }) {
  const [load, loadAction] = useFormState(loadAstralOrganizations, orgs0);
  const [save, saveAction] = useFormState(selectAstralOrganization, mut0);
  return (
    <div className="space-y-3">
      {boundOrganizationId ? (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">Выбрана организация Астрал: <b>{boundOrganizationId}</b>{boundLegalEntityId ? ` → юрлицо привязано` : ""}.</div>
      ) : null}
      <form action={loadAction}><Btn label="Загрузить организации" /> <Msg state={load} /></form>
      {load.ok && load.organizations ? (
        load.organizations.length === 0 ? (
          <p className="text-xs text-slate-500">Организации не найдены.</p>
        ) : (
          <form action={saveAction} className="space-y-2">
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {load.organizations.map((o) => (
                <label key={o.externalOrganizationId} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
                  <input type="radio" name="organizationId" value={o.externalOrganizationId} defaultChecked={o.externalOrganizationId === boundOrganizationId} />
                  <span className="text-sm">
                    <b>{o.title ?? "—"}</b>
                    <span className="ml-2 text-xs text-slate-500">ИНН {o.inn ?? "—"}{o.kpp ? ` · КПП ${o.kpp}` : ""} · договор {o.statusContract ?? "—"} · ФНС {o.fnsStatus ?? "—"}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-slate-600">Привязать к юрлицу:</label>
              <select name="legalEntityId" defaultValue={boundLegalEntityId ?? ""} className="input py-1 text-sm">
                <option value="">— выберите —</option>
                {legalEntities.map((le) => <option key={le.id} value={le.id}>{le.name}</option>)}
              </select>
              <Btn label="Сохранить привязку" variant="primary" />
              <Msg state={save} />
            </div>
            <p className="text-[11px] text-slate-400">Привязка не выполняется автоматически по совпадению ИНН — подтвердите вручную.</p>
          </form>
        )
      ) : null}
    </div>
  );
}

// ---- Step 3: outlets ---------------------------------------------------------

export function AstralOutletStep() {
  const [load, loadAction] = useFormState(loadAstralOutlets, outlets0);
  return (
    <div className="space-y-3">
      <form action={loadAction}><Btn label="Загрузить торговые точки" /> <Msg state={load} /></form>
      {load.ok && load.outlets ? (
        load.outlets.length === 0 ? (
          <p className="text-xs text-slate-500">Торговые точки не найдены.</p>
        ) : (
          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {load.outlets.map((o) => (
              <div key={o.externalAliasId} className="flex items-center justify-between px-3 py-2">
                <span><b>{o.alias ?? "—"}</b>{o.address ? <span className="ml-2 text-xs text-slate-500">{o.address}</span> : null}</span>
                <span className="text-xs text-slate-500">касс: {o.totalCount} · id {o.externalAliasId}</span>
              </div>
            ))}
          </div>
        )
      ) : null}
      <p className="text-[11px] text-slate-400">Привязка точки к клубу выполняется на шаге 4 (для каждой кассы точки выбирается клуб и юрлицо).</p>
    </div>
  );
}

// ---- Step 4: KKTs → Club + LegalEntity ---------------------------------------

export function AstralKktStep({ legalEntities, clubs, boundLegalEntityId, boundKkts }: { legalEntities: LE[]; clubs: Club[]; boundLegalEntityId: string | null; boundKkts: BoundKkt[] }) {
  const [load, loadAction] = useFormState(loadAstralKkts, kkts0);
  const [bind, bindAction] = useFormState(bindAstralKkt, mut0);
  const [unbind, unbindAction] = useFormState(unbindAstralKkt, mut0);
  return (
    <div className="space-y-3">
      {boundKkts.length ? (
        <div className="rounded-lg border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-500">Привязанные кассы</div>
          {boundKkts.map((k) => (
            <div key={k.fnNumber} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{k.label} <span className="text-xs text-slate-500">→ {k.clubName} / {k.legalName}</span></span>
              <form action={unbindAction}><input type="hidden" name="fnNumber" value={k.fnNumber} /><Btn label="Отвязать" /></form>
            </div>
          ))}
          <div className="px-3 py-1"><Msg state={unbind} /></div>
        </div>
      ) : null}

      <form action={loadAction} className="flex flex-wrap items-center gap-2">
        <input name="aliasId" placeholder="id точки (необязательно)" className="input py-1 text-sm" />
        <Btn label="Загрузить кассы" /> <Msg state={load} />
      </form>

      {load.ok && load.kkts ? (
        load.kkts.length === 0 ? (
          <p className="text-xs text-slate-500">Кассы не найдены.</p>
        ) : (
          <div className="space-y-2">
            {load.kkts.map((k) => (
              <form key={k.externalKktId} action={bindAction} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
                <input type="hidden" name="externalKktId" value={k.externalKktId} />
                <input type="hidden" name="fnNumber" value={k.factoryFiscalDrive ?? ""} />
                <input type="hidden" name="kktRegId" value={k.kktRegId ?? ""} />
                <input type="hidden" name="numberKKT" value={k.numberKKT ?? ""} />
                <input type="hidden" name="externalAliasId" value={k.externalAliasId ?? ""} />
                <input type="hidden" name="kktName" value={k.nameModelKKT ?? k.alias ?? ""} />
                <span className="text-sm"><b>{k.numberKKT ?? k.factoryFiscalDrive ?? k.externalKktId}</b> <span className="text-xs text-slate-500">{k.nameModelKKT ?? ""} · ФН {k.factoryFiscalDrive ?? "—"} · {k.statusOfd ?? ""}</span></span>
                <select name="clubId" className="input py-1 text-sm" defaultValue="">
                  <option value="">клуб…</option>
                  {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select name="legalEntityId" className="input py-1 text-sm" defaultValue={boundLegalEntityId ?? ""}>
                  <option value="">юрлицо…</option>
                  {legalEntities.map((le) => <option key={le.id} value={le.id}>{le.name}</option>)}
                </select>
                <Btn label="Привязать" variant="primary" />
                {!k.factoryFiscalDrive ? <span className="text-xs text-amber-600">нет ФН</span> : null}
              </form>
            ))}
            <Msg state={bind} />
          </div>
        )
      ) : null}
    </div>
  );
}
