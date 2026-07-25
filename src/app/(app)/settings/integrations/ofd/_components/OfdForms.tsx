"use client";

import { Fragment, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { saveOfdConnection, addOfdMapping, updateOfdMapping, runOfdImport, checkOfdConnection, syncOfdNowAction, reclassifyOfdCategoriesAction, inspectOfdNewDocumentsAction, inspectOfdDocumentInfoAction, loadTaxcomContractsAction, selectTaxcomContractAction } from "../actions";
import type { OfdSyncSummary, OfdClubResult } from "../actions";
import type { OfdCheckDiagnostics, OfdSafeContract } from "@/lib/ofd/contract";
import type { NewDocumentsShape, DocumentInfoShape } from "@/lib/ofd/types";
import { formatKopeks } from "@/lib/money";

type State = { ok: boolean; error?: string; notice?: string; code?: string; diagnostics?: OfdCheckDiagnostics; matchedContract?: OfdSafeContract; currentSession?: string | null; sync?: OfdSyncSummary; perClub?: OfdClubResult[]; unboundKkts?: number; clubNote?: string; newDocsShape?: NewDocumentsShape; docInfoShape?: DocumentInfoShape };
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
      <input type="hidden" name="connectionId" value={connection?.id ?? ""} />
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
            Договор выбран и доступен в AccountList, но Такском открыл API-сессию в другом ЛК: <span className="font-mono">{wrongAccountDiag.currentSession ?? "—"}</span>. Для импорта нужен текущий ЛК: <span className="font-mono">{wrongAccountDiag.requestedContractNumber}</span>.
          </div>
          <div className="mt-1">
            Выбор договора в CLUB-OPS не переключает API-сессию на стороне Такском. Уточните у Такском, какой идентификатор/параметр переключает API-сессию на выбранный договор{wantedName ? ` («${wantedName}»)` : ""}, либо создайте отдельного пользователя Такском для нужного ЛК.
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

/** Contract picker: load the SAFE список договоров from AccountList and pick the ЛК
 * for this connection. Picking only saves contractNumber — it never marks the
 * connection working (that needs "Проверить подключение"). Renders no secrets. */
export function OfdContractPicker({ connectionId }: { connectionId: string }) {
  const [loadState, loadAction] = useFormState(loadTaxcomContractsAction, initial);
  const [selectState, selectAction] = useFormState(selectTaxcomContractAction, initial);
  const loaded = loadState.ok && loadState.code === "contracts_loaded";
  const contracts = loaded ? loadState.diagnostics?.availableContracts ?? [] : [];
  const current = loadState.diagnostics?.currentSession ?? null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-medium text-brand-700">Выбрать договор из Такском</summary>
      <div className="mt-3 border-t border-slate-100 pt-3">
        <form action={loadAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="connectionId" value={connectionId} />
          <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">Загрузить договоры из Такском</button>
          <Msg s={loadState} />
        </form>
        {loaded ? (
          <div className="mt-3">
            {current ? <div className="mb-2 text-xs text-slate-500">Текущий ЛК Такском (API-сессия): <span className="font-mono">{current}</span></div> : null}
            {contracts.length === 0 ? (
              <div className="text-sm text-slate-500">Такском не вернул договоров для этого логина.</div>
            ) : (
              <ul className="space-y-2">
                {contracts.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1.5">
                    <span className="text-sm">
                      <span className="font-mono">{a.agreementNumber ?? "—"}</span>
                      {a.companyName ? <> · {a.companyName}</> : null}
                      {a.inn ? <> · ИНН {a.inn}</> : null}
                      {a.kpp ? <> · КПП {a.kpp}</> : null}
                    </span>
                    <form action={selectAction}>
                      <input type="hidden" name="connectionId" value={connectionId} />
                      <input type="hidden" name="agreementNumber" value={a.agreementNumber ?? ""} />
                      <button type="submit" className="rounded-md border border-brand-300 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100">Выбрать</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        <div className="mt-2"><Msg s={selectState} /></div>
      </div>
    </details>
  );
}

type ConnOpt = { id: string; label: string };
export function OfdMappingForm({ connections, clubs, entities }: { connections: ConnOpt[]; clubs: ClubOpt[]; entities: EntityOpt[] }) {
  const [state, action] = useFormState(addOfdMapping, initial);
  const [kind, setKind] = useState("club_cashbox");
  return (
    <form action={action} className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Field label="Подключение Такском">
        <select name="connectionId" required defaultValue={connections[0]?.id ?? ""} className="input">
          {connections.length === 0 ? <option value="" disabled>Нет подключений</option> : null}
          {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </Field>
      <Field label="ФН"><input name="fnNumber" required placeholder="номер ФН" className="input" /></Field>
      <Field label="РНМ ККТ (необязательно)"><input name="kktRegNumber" className="input" /></Field>
      <Field label="Название кассы (необязательно)"><input name="kktName" className="input" /></Field>
      <Field label="Клуб">
        <select name="clubId" required defaultValue="" className="input">
          <option value="" disabled>Выберите клуб</option>
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Юрлицо кассы">
        <select name="legalEntityId" required defaultValue="" className="input">
          <option value="" disabled>Выберите юрлицо</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </Field>
      <Field label="Тип кассы">
        <select name="registerKind" value={kind} onChange={(e) => setKind(e.target.value)} className="input">
          <option value="club_cashbox">Касса клуба</option>
          <option value="online_cashbox">Онлайн-касса</option>
        </select>
      </Field>
      <p className="text-xs text-slate-500 md:col-span-3">
        {kind === "online_cashbox"
          ? "Используется для чеков онлайн-оплат. Источник будет отмечен как онлайн-касса."
          : "Обычная касса клуба/ресепшена. Юрлицо задаётся ДЛЯ КАЖДОЙ кассы — один кабинет Такском может содержать кассы разных юрлиц."}
      </p>
      <div className="flex items-end justify-between gap-3 md:col-span-3">
        <Msg s={state} />
        <Submit idle="Добавить кассу" busy="Добавление..." />
      </div>
    </form>
  );
}

/** Inline «Изменить привязку»: set an existing KKT's club + legal entity (§7). */
export function OfdMappingEditForm({ mappingId, clubs, entities, currentClubId, currentLegalId }: { mappingId: string; clubs: ClubOpt[]; entities: EntityOpt[]; currentClubId: string; currentLegalId: string | null }) {
  const [state, action] = useFormState(updateOfdMapping, initial);
  const [open, setOpen] = useState(false);
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className={`rounded-md border px-2.5 py-1 text-xs font-medium ${currentLegalId ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50" : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"}`}>{currentLegalId ? "Изменить привязку" : "Указать юрлицо"}</button>;
  }
  return (
    <form action={action} className="flex flex-col gap-1 rounded-md border border-slate-200 bg-slate-50 p-2">
      <input type="hidden" name="mappingId" value={mappingId} />
      <select name="clubId" defaultValue={currentClubId} className="input py-1 text-xs">
        {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select name="legalEntityId" required defaultValue={currentLegalId ?? ""} className="input py-1 text-xs">
        <option value="" disabled>Юрлицо…</option>
        {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      <div className="flex items-center gap-1">
        <Submit idle="Сохранить" busy="…" />
        <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600">Отмена</button>
      </div>
      {state.error ? <span className="text-xs text-rose-600">{state.error}</span> : null}
    </form>
  );
}

export function OfdImportForm({ connections }: { connections: ConnOpt[] }) {
  const [state, action] = useFormState(runOfdImport, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <Field label="Подключение (кабинет)">
        <select name="connectionId" required defaultValue={connections[0]?.id ?? ""} className="input">
          {connections.length === 0 ? <option value="" disabled>Нет подключений</option> : null}
          {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </Field>
      <Field label="Дата от"><input type="date" name="dateFrom" required defaultValue="2026-07-01" className="input" /></Field>
      <Field label="Дата до"><input type="date" name="dateTo" required defaultValue="2026-07-31" className="input" /></Field>
      <Submit idle="Импортировать" busy="Импорт..." />
      <div className="w-full"><Msg s={state} /></div>
      {state.ok && state.perClub && state.perClub.length ? (
        <div className="w-full rounded-lg border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-500">Итог по клубам</div>
          {state.perClub.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span><b>{c.clubName}</b>{c.legalName ? <span className="ml-1 text-xs text-slate-500">· {c.legalName}</span> : null}</span>
              <span className="text-xs text-slate-600">чеков {c.found}, добавлено {c.imported}, приход {formatKopeks(c.incomeKopeks)}{c.returnKopeks ? `, возвраты ${formatKopeks(c.returnKopeks)}` : ""}</span>
            </div>
          ))}
        </div>
      ) : null}
      {state.clubNote ? <p className="w-full text-xs text-slate-500">{state.clubNote}</p> : null}
      <p className="w-full text-xs text-slate-500">Импорт идёт по всему кабинету (всем активным кассам подключения) — каждый чек разносится по своему клубу и юрлицу. Кассы без юрлица пропускаются до привязки.</p>
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

export function OfdRecalcCategories() {
  const [state, action] = useFormState(reclassifyOfdCategoriesAction, initial);
  return (
    <form action={action} className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Submit idle="Пересчитать статьи доходов" busy="Пересчёт..." />
        <span className="text-xs text-slate-500">Используется после изменения правил распознавания номенклатуры. Не запрашивает ОФД повторно.</span>
      </div>
      <Msg s={state} />
    </form>
  );
}

type RevRow = { code: string; name: string; income: number; ret: number; net: number; items: number; receipts: number };
type RevDetail = { normalizedName: string; net: number; income: number; itemCount: number; receiptCount: number; examples: string[] };

export function OfdRevenueTable({ rows, details }: { rows: RevRow[]; details: Record<string, RevDetail[]> }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-slate-600">Статья</th>
            <th className="px-3 py-2 text-left font-medium text-slate-600">Приход</th>
            <th className="px-3 py-2 text-left font-medium text-slate-600">Возвраты</th>
            <th className="px-3 py-2 text-left font-medium text-slate-600">Итог</th>
            <th className="px-3 py-2 text-left font-medium text-slate-600">Позиций</th>
            <th className="px-3 py-2 text-left font-medium text-slate-600">Чеков</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((c) => {
            const isOpen = !!open[c.code];
            const d = details[c.code] ?? [];
            return (
              <Fragment key={c.code}>
                <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen((o) => ({ ...o, [c.code]: !o[c.code] }))}>
                  <td className="px-3 py-2">
                    <button type="button" className="mr-1.5 inline-block w-3 text-slate-400" aria-expanded={isOpen} aria-label={isOpen ? "Скрыть" : "Раскрыть"}>{isOpen ? "▾" : "▸"}</button>
                    {c.name}
                  </td>
                  <td className="px-3 py-2">{formatKopeks(c.income)}</td>
                  <td className="px-3 py-2">{formatKopeks(c.ret)}</td>
                  <td className="px-3 py-2 font-medium text-slate-900">{formatKopeks(c.net)}</td>
                  <td className="px-3 py-2">{c.items}</td>
                  <td className="px-3 py-2">{c.receipts}</td>
                </tr>
                {isOpen ? (
                  <tr className="bg-slate-50/60">
                    <td colSpan={6} className="px-3 py-3">
                      {d.length === 0 ? (
                        <div className="text-sm text-slate-500">Нет детализации по позициям</div>
                      ) : (
                        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
                          <table className="min-w-full divide-y divide-slate-200 text-xs">
                            <thead className="bg-slate-50">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium text-slate-500">Название</th>
                                <th className="px-3 py-2 text-left font-medium text-slate-500">Примеры исходных названий</th>
                                <th className="px-3 py-2 text-left font-medium text-slate-500">Сумма</th>
                                <th className="px-3 py-2 text-left font-medium text-slate-500">Позиций</th>
                                <th className="px-3 py-2 text-left font-medium text-slate-500">Чеков</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {d.map((r, i) => (
                                <tr key={i}>
                                  <td className="px-3 py-2 font-medium text-slate-800">{r.normalizedName || "—"}</td>
                                  <td className="px-3 py-2 text-slate-500">
                                    {r.examples.length ? r.examples.map((e, j) => (
                                      <div key={j} className="max-w-[24rem] truncate" title={e}>{e}</div>
                                    )) : "—"}
                                  </td>
                                  <td className="px-3 py-2 whitespace-nowrap">{formatKopeks(r.net)}</td>
                                  <td className="px-3 py-2">{r.itemCount}</td>
                                  <td className="px-3 py-2">{r.receiptCount}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OfdNewDocsDiagnostics({ connectionId }: { connectionId: string }) {
  const [state, action] = useFormState(inspectOfdNewDocumentsAction, initial);
  const shape = state.ok ? state.newDocsShape : undefined;
  return (
    <div>
      <form action={action} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="connectionId" value={connectionId} />
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          Проверить структуру NewDocuments
        </button>
        <span className="text-xs text-slate-500">Диагностика: показывает только структуру ответа (ключи и счётчики), без содержимого чеков.</span>
      </form>
      {state.error ? <p className="mt-2 text-sm text-rose-600">{state.error}</p> : null}
      {shape ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
          <div className="mb-1">{state.notice}</div>
          <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
            <div><span className="text-slate-500">Документов:</span> {shape.documentCount}</div>
            <div><span className="text-slate-500">Позиции чеков:</span> {shape.hasItemsLikeData ? <span className="text-emerald-700 font-medium">найдены</span> : <span className="text-slate-500">не найдены</span>}</div>
            <div className="md:col-span-2"><span className="text-slate-500">Ключи первого документа:</span> {shape.firstDocumentKeys.length ? <span className="font-mono">{shape.firstDocumentKeys.join(", ")}</span> : "—"}</div>
            {shape.detectedItemLikeKeys.length ? (
              <div className="md:col-span-2"><span className="text-slate-500">Поля позиций:</span> <span className="font-mono">{shape.detectedItemLikeKeys.join(", ")}</span></div>
            ) : null}
            {Object.keys(shape.documentTypeCounts).length ? (
              <div className="md:col-span-2"><span className="text-slate-500">Типы документов:</span> <span className="font-mono">{Object.entries(shape.documentTypeCounts).map(([t, n]) => `${t}:${n}`).join(", ")}</span></div>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-slate-500">Сырой ответ Такском не отображается и не сохраняется.</p>
        </div>
      ) : null}
    </div>
  );
}

export function OfdDocInfoDiagnostics({ connectionId }: { connectionId: string }) {
  const [state, action] = useFormState(inspectOfdDocumentInfoAction, initial);
  const shape = state.ok ? state.docInfoShape : undefined;
  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="connectionId" value={connectionId} />
        <Field label="ФН"><input name="fnNumber" required placeholder="номер ФН" className="input" /></Field>
        <Field label="ФД"><input name="fdNumber" required inputMode="numeric" placeholder="номер ФД" className="input" /></Field>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          Проверить DocumentInfo
        </button>
      </form>
      <p className="mt-1 text-xs text-slate-500">ФН и ФД можно взять из истории импорта / DocumentList. Показывается только структура ответа, без содержимого чека.</p>
      {state.error ? <p className="mt-2 text-sm text-rose-600">{state.error}</p> : null}
      {shape ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
          <div className="mb-1">{state.notice}</div>
          <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
            <div><span className="text-slate-500">Позиции чека:</span> {shape.hasItemsLikeData ? <span className="text-emerald-700 font-medium">найдены ({shape.itemLikeCount})</span> : <span className="text-slate-500">не найдены</span>}</div>
            <div><span className="text-slate-500">Формат ФФД (тег 1059):</span> {shape.numericFfdModeDetected ? <span className="text-emerald-700 font-medium">обнаружен</span> : <span className="text-slate-500">нет</span>}</div>
            {shape.safeDocumentType ? <div><span className="text-slate-500">Тип документа:</span> <span className="font-mono">{shape.safeDocumentType}</span></div> : null}
            <div className="md:col-span-2">
              <span className="text-slate-500">Поля кассира в чеке:</span>{" "}
              {shape.cashierDetected ? <span className="text-emerald-700 font-medium">обнаружены</span> : <span className="text-slate-500">нет</span>}
              {shape.cashierFieldsDetected.length ? <span className="ml-1 font-mono text-xs text-slate-500">(теги: {shape.cashierFieldsDetected.join(", ")})</span> : null}
              <span className="ml-1 text-xs text-slate-400">— только факт наличия, без ФИО/ИНН. Для расчёта ЗП потребуется отдельная модель.</span>
            </div>
            <div className="md:col-span-2"><span className="text-slate-500">Ключи верхнего уровня:</span> {shape.topLevelKeys.length ? <span className="font-mono">{shape.topLevelKeys.join(", ")}</span> : "—"}</div>
            <div className="md:col-span-2"><span className="text-slate-500">Ключи документа:</span> {shape.documentKeys.length ? <span className="font-mono">{shape.documentKeys.join(", ")}</span> : "—"}</div>
            {shape.detectedItemLikeKeys.length ? (
              <div className="md:col-span-2"><span className="text-slate-500">Поля позиций:</span> <span className="font-mono">{shape.detectedItemLikeKeys.join(", ")}</span></div>
            ) : null}
            {shape.firstItemKeys.length ? (
              <div className="md:col-span-2"><span className="text-slate-500">Ключи первой позиции:</span> <span className="font-mono">{shape.firstItemKeys.join(", ")}</span></div>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-slate-500">Сырой ответ Такском не отображается и не сохраняется.</p>
        </div>
      ) : null}
    </div>
  );
}
