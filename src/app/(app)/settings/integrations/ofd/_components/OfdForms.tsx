"use client";

import { useFormState, useFormStatus } from "react-dom";
import { saveOfdConnection, addOfdMapping, runOfdImport, checkOfdConnection } from "../actions";

type State = { ok: boolean; error?: string; notice?: string };
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
  const secretStatus = (has: boolean) => (has ? "настроен" : "не настроен");
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Field label="Название">
        <input name="displayName" required defaultValue={connection?.displayName ?? "Такском"} className="input" />
      </Field>
      <Field label="Адрес сервера (https://…)">
        <input name="serverBaseUrl" required placeholder="https://server.taxcom.ru" defaultValue={connection?.serverBaseUrl ?? ""} className="input" />
      </Field>
      <Field label="Тип авторизации">
        <select name="authType" defaultValue={connection?.authType ?? "login_password"} className="input">
          <option value="login_password">Логин / пароль</option>
          <option value="integration_token">Токен интеграции</option>
        </select>
      </Field>
      <div className="md:col-span-2 rounded-md border border-brand-200 bg-brand-50/40 p-3">
        <Field label="Номер договора Такском">
          <input name="contractNumber" required defaultValue={connection?.contractNumber ?? ""} placeholder="CD-25/45507" className="input" />
        </Field>
        <p className="mt-1 text-xs text-slate-600">
          Нужен, если в одном логине несколько организаций / личных кабинетов. Выбирает нужный договор при входе. Например: <span className="font-mono">CD-25/45507</span>.
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
          <Field label="Логин"><input name="login" autoComplete="off" placeholder="••••••" className="input" /></Field>
          <Field label="Пароль"><input name="password" type="password" autoComplete="new-password" placeholder="••••••" className="input" /></Field>
          <Field label="Токен интеграции"><input name="integrationToken" autoComplete="off" placeholder="••••••" className="input" /></Field>
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

export function OfdCheckConnection({ connectionId }: { connectionId: string }) {
  const [state, action] = useFormState(checkOfdConnection, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="connectionId" value={connectionId} />
      <button type="submit" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
        Проверить подключение
      </button>
      <Msg s={state} />
    </form>
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
