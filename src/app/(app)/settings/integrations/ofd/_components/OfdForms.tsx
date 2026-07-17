"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { saveOfdConnection, addOfdMapping, runOfdImport, checkOfdConnection, syncOfdNowAction } from "../actions";
import type { OfdSyncSummary } from "../actions";
import type { OfdCheckDiagnostics, OfdSafeContract } from "@/lib/ofd/contract";
import { formatKopeks } from "@/lib/money";

type State = { ok: boolean; error?: string; notice?: string; code?: string; diagnostics?: OfdCheckDiagnostics; matchedContract?: OfdSafeContract; currentSession?: string | null; sync?: OfdSyncSummary };
const initial: State = { ok: false };

type ClubOpt = { id: string; name: string };
type EntityOpt = { id: string; name: string };

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60">
      {pending ? busy : idle}
    </button>
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

function Msg({ s }: { s: State }) {
  if (s.ok && s.notice) return <p className="mt-2 text-sm text-emerald-700">{s.notice}</p>;
  if (s.error) return <p className="mt-2 text-sm text-rose-600">{s.error}</p>;
  return null;
}

export function OfdConnectionForm({
  connection, clubs, entities,
}: {
  connection: { id: string; displayName: string; serverBaseUrl: string; contractNumber: string | null; authType: string; legalEntityId: string | null; hasLogin: boolean; hasPassword: boolean; hasToken: boolean } | null;
  clubs: ClubOpt[];
  entities: EntityOpt[];
}) {
  const [state, action] = useFormState(saveOfdConnection, initial);
  const [authType, setAuthType] = useState(connection?.authType ?? "login_password");
  const secretStatus = (has: boolean) => (has ? "настроен" : "не настроен");
  const isTokenAuth = authType === "integration_token";
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="Название">
        <input name="displayName" required defaultValue={connection?.displayName ?? "Такском"} className="input" />
      </Field>
      <Field label="Адрес сервера (https://…)">
        <input name="serverBaseUrl" required placeholder="https://server.taxcom.ru" defaultValue={connection?.serverBaseUrl ?? ""} className="input" />
      </Field>
      <Field label="Тип авторизации">
        <select name="authType" value={authType} onChange={(e) => setAuthType(e.target.value)} className="input">
          <option value="login_password">Логин / пароль</option>
          <option value="integration_token">Токен интеграции</option>
        </select>
      </Field>
      <div className="md:col-span-2 rounded-md border border-brand-200 bg-brand-50/40 p-3">
        <Field label="Номер договора Такском">
          <input name="contractNumber" defaultValue={connection?.contractNumber ?? ""} placeholder="CD-25/45507" className="input" />
        </Field>
        <p className="mt-1 text-xs text-slate-600">
          Используется для проверки, что выбран нужный ЛК/договор. Сам Login Такском выполняется без этого поля. Например: <span className="font-mono">CD-25/45507</span>.
        </p>
      </div>
      <Field label="Юрлицо (ООО)">
        <select name="legalEntityId" defaultValue={connection?.legalEntityId ?? ""} className="input">
          <option value="">— не выбрано —</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </Field>
      <div className="md:col-span-2 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="mb-2 text-xs font-medium text-slate-500">
          Секреты хранятся в зашифрованном виде и не отображаются. Заполните только для установки/замены.
          {connection ? ` Текущий статус — логин: ${secretStatus(connection.hasLogin)}, пароль: ${secretStatus(connection.hasPassword)}, токен: ${secretStatus(connection.hasToken)}.` : ""}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {isTokenAuth ? (
            <Field label="Токен интеграции"><input name="integrationToken" autoComplete="off" placeholder="••••••" className="input" /></Field>
          ) : (
            <>
              <Field label="Логин"><input name="login" autoComplete="off" placeholder="••••••" className="input" /></Field>
              <Field label="Пароль"><input name="password" type="password" autoComplete="new-password" placeholder="••••••" className="input" /></Field>
            </>
          )}
          <Field label="Integrator ID"><input name="integratorId" autoComplete="off" placeholder="••••••" className="input" /></Field>
        </div>
      </div>
      <div className="md:col-span-2 flex items-center justify-between gap-3">
        <Msg s={state} />
        <Submit idle="Сохранить подключение" busy="Сохранение..." />
      </div>
    </form>
  );
}

function contractLabel(a: OfdSafeContract): string {
  return [a.agreementNumber ?? "—", a.companyName, a.inn ? `ИНН ${a.inn}` : null, a.kpp ? `КПП ${a.kpp}` : null].filter(Boolean).join(" · ");
}

function ContractList({ items }: { items: OfdSafeContract[] }) {
  return (
    <>
      <div className="mt-2 font-medium">Доступные договоры Такском:</div>
      {items.length === 0 ? (
        <div className="mt-1 text-amber-800">Такском не вернул ни одного договора.</div>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((a, i) => (
            <li key={i} className="rounded border border-amber-200 bg-white/60 px-2 py-1">
              <span className="font-mono">{a.agreementNumber ?? "—"}</span>
              {a.companyName ? <> · {a.companyName}</> : null}
              {a.inn ? <> · ИНН {a.inn}</> : null}
              {a.kpp ? <> · КПП {a.kpp}</> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function OfdCheckConnection({ connectionId }: { connectionId: string }) {
  const [state, action] = useFormState(checkOfdConnection, initial);
  const notFoundDiag = state.code === "contract_not_found" ? state.diagnostics : undefined;
  const wrongAccountDiag = state.code === "taxcom_wrong_current_account" ? state.diagnostics : undefined;
  const matched = state.ok ? state.matchedContract : undefined;
  const wantedName = wrongAccountDiag?.matchedContract?.companyName;
  return (
    <div>
      <form action={action} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="connectionId" value={connectionId} />
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          Проверить подключение
        </button>
        <Msg s={state} />
      </form>
      {matched ? (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <div><span className="font-medium">Договор найден:</span> <span className="font-mono">{contractLabel(matched)}</span></div>
          {state.currentSession ? (
            <div className="mt-0.5"><span className="font-medium">Текущий ЛК Такском:</span> <span className="font-mono">{state.currentSession}</span></div>
          ) : null}
        </div>
      ) : null}
      {wrongAccountDiag ? (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div>
            Договор доступен, но текущий ЛК Такском: <span className="font-mono">{wrongAccountDiag.currentSession ?? "—"}</span>. Для импорта нужен текущий ЛК: <span className="font-mono">{wrongAccountDiag.requestedContractNumber}</span>.
          </div>
          <div className="mt-1">
            Создайте отдельного пользователя Такском для {wantedName ? `«${wantedName}»` : "нужного договора"} или уточните у Такском, как выбрать ЛК для API.
          </div>
          <ContractList items={wrongAccountDiag.availableContracts} />
        </div>
      ) : null}
      {notFoundDiag ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div><span className="font-medium">Искомый договор:</span> <span className="font-mono">{notFoundDiag.requestedContractNumber}</span></div>
          <div className="mt-0.5"><span className="font-medium">Текущий ЛК Такском:</span> {notFoundDiag.currentSession ?? "—"}</div>
          <ContractList items={notFoundDiag.availableContracts} />
        </div>
      ) : null}
    </div>
  );
}

export function OfdMappingForm({ connectionId, clubs, entities }: { connectionId: string; clubs: ClubOpt[]; entities: EntityOpt[] }) {
  const [state, action] = useFormState(addOfdMapping, initial);
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Field label="ФН"><input name="fnNumber" required placeholder="номер ФН" className="input" /></Field>
      <Field label="РНМ ККТ (необязательно)"><input name="kktRegNumber" className="input" /></Field>
      <Field label="Название кассы (необязательно)"><input name="kktName" className="input" /></Field>
      <Field label="Клуб">
        <select name="clubId" required defaultValue="" className="input">
          <option value="" disabled>Выберите клуб</option>
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Юрлицо">
        <select name="legalEntityId" defaultValue="" className="input">
          <option value="">— по подключению —</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </Field>
      <div className="flex items-end justify-between gap-3 md:col-span-3">
        <Msg s={state} />
        <Submit idle="Добавить кассу" busy="Добавление..." />
      </div>
    </form>
  );
}

export function OfdImportForm({ connectionId }: { connectionId: string }) {
  const [state, action] = useFormState(runOfdImport, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Field label="Дата от"><input type="date" name="dateFrom" required defaultValue="2026-07-01" className="input" /></Field>
      <Field label="Дата до"><input type="date" name="dateTo" required defaultValue="2026-07-31" className="input" /></Field>
      <Submit idle="Импортировать" busy="Импорт..." />
      <div className="w-full"><Msg s={state} /></div>
      <p className="w-full text-xs text-slate-500">Для истории за июль выберите 2026-07-01 — 2026-07-31.</p>
    </form>
  );
}

export function OfdSyncNow() {
  const [state, action] = useFormState(syncOfdNowAction, initial);
  const sync = state.ok ? state.sync : undefined;
  return (
    <form action={action}>
      <div className="flex flex-wrap items-center gap-3">
        <Submit idle="Синхронизировать сейчас" busy="Синхронизация..." />
        <span className="text-xs text-slate-500">Подтягивает чеки за текущий день. Повторный запуск безопасен — дубли не создаются.</span>
      </div>
      {sync ? (
        <div className={`mt-3 rounded-md border p-3 text-sm ${sync.failed > 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          <div>{state.notice}</div>
          <div className="mt-0.5">Приход: {formatKopeks(sync.incomeKopeks)} · Возвраты: {formatKopeks(sync.returnKopeks)}</div>
          {sync.failed > 0 ? (
            <div className="mt-1">Внимание: часть подключений не синхронизировалась ({sync.failed} из {sync.succeeded + sync.failed}). Подробности — в истории синхронизаций.</div>
          ) : null}
        </div>
      ) : (
        <Msg s={state} />
      )}
    </form>
  );
}
