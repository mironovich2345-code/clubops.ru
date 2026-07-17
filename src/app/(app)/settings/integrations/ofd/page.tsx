import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { getCurrentAccessContext, userHasCompanyRole } from "@/lib/access";
import { ofdEnabled, ofdConfigured } from "@/lib/ofd/config";
import { toggleOfdMapping } from "./actions";
import { OfdConnectionForm, OfdMappingForm, OfdImportForm, OfdCheckConnection, OfdSyncNow } from "./_components/OfdForms";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default async function OfdIntegrationPage() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/settings");
  const companyId = ctx.selectedCompanyId;
  const isAdmin = await userHasCompanyRole(ctx.user.id, companyId, ["owner", "general_director"]);
  if (!isAdmin) redirect("/settings");

  const [connectionRow, clubs, entities] = await Promise.all([
    prisma.ofdConnection.findFirst({ where: { companyId, provider: "taxcom" } }),
    prisma.club.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.legalEntity.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));

  const connection = connectionRow
    ? {
        id: connectionRow.id, displayName: connectionRow.displayName, serverBaseUrl: connectionRow.serverBaseUrl,
        contractNumber: connectionRow.contractNumber, authType: connectionRow.authType, legalEntityId: connectionRow.legalEntityId,
        hasLogin: Boolean(connectionRow.loginEncrypted), hasPassword: Boolean(connectionRow.passwordEncrypted), hasToken: Boolean(connectionRow.integrationTokenEncrypted),
      }
    : null;

  const [mappings, runs, summaries, lastAutoRun] = connectionRow
    ? await Promise.all([
        prisma.ofdCashRegisterMapping.findMany({ where: { connectionId: connectionRow.id }, orderBy: { createdAt: "desc" } }),
        prisma.ofdSyncRun.findMany({ where: { connectionId: connectionRow.id }, orderBy: { createdAt: "desc" }, take: 10 }),
        prisma.ofdDailySalesSummary.findMany({ where: { companyId, provider: "taxcom" } }),
        prisma.ofdSyncRun.findFirst({ where: { connectionId: connectionRow.id, mode: "auto_daily" }, orderBy: { createdAt: "desc" } }),
      ])
    : [[], [], [], null] as const;

  const lastAutoErrorCount = lastAutoRun ? await prisma.ofdSyncError.count({ where: { syncRunId: lastAutoRun.id } }) : 0;

  const errorCounts = new Map<string, number>();
  if (runs.length) {
    const errs = await prisma.ofdSyncError.groupBy({ by: ["syncRunId"], where: { syncRunId: { in: runs.map((r) => r.id) } }, _count: { _all: true } });
    for (const e of errs) errorCounts.set(e.syncRunId, e._count._all);
  }

  const today = ymd(new Date());
  const yesterday = ymd(new Date(Date.now() - 86_400_000));
  const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

  // Aggregate OFD sales per club for today / yesterday / July.
  type Agg = { income: number; cash: number; electronic: number; ret: number; net: number };
  const zero = (): Agg => ({ income: 0, cash: 0, electronic: 0, ret: 0, net: 0 });
  function aggFor(from: string, to: string): Map<string, Agg> {
    const m = new Map<string, Agg>();
    for (const s of summaries) {
      if (!inRange(s.date, from, to)) continue;
      const a = m.get(s.clubId) ?? zero();
      a.income += s.incomeTotalKopeks; a.cash += s.incomeCashKopeks; a.electronic += s.incomeElectronicKopeks;
      a.ret += s.returnTotalKopeks; a.net += s.netTotalKopeks;
      m.set(s.clubId, a);
    }
    return m;
  }

  return (
    <div className="max-w-4xl">
      <PageHeader title="ОФД Такском" description="Подключение продаж по API ОФД (только владелец / ген. директор)" />

      {!ofdEnabled() ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Интеграции ОФД отключены (OFD_INTEGRATIONS_ENABLED). Обратитесь к администратору системы.
        </div>
      ) : (
        <>
          {!ofdConfigured() ? (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              OFD_SECRET не настроен — сохранение секретов подключения будет недоступно.
            </div>
          ) : null}

          <Section title="Подключение">
            <OfdConnectionForm connection={connection} clubs={clubs} entities={entities} />
            {connectionRow ? (
              <div className="mt-4 border-t border-slate-200 pt-4">
                <OfdCheckConnection connectionId={connectionRow.id} />
              </div>
            ) : null}
          </Section>

          {connectionRow ? (
            <>
              <Section title="Кассы (ККТ → клуб)">
                <OfdMappingForm connectionId={connectionRow.id} clubs={clubs} entities={entities} />
                <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50"><tr><Th>ФН</Th><Th>Касса</Th><Th>Клуб</Th><Th>Статус</Th><Th>Действия</Th></tr></thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {mappings.length === 0 ? <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">Кассы не сопоставлены.</td></tr> :
                        mappings.map((m) => (
                          <tr key={m.id}>
                            <Td>{m.fnNumber}</Td>
                            <Td>{m.kktName ?? m.kktRegNumber ?? "—"}</Td>
                            <Td>{clubName.get(m.clubId) ?? "—"}</Td>
                            <Td>{m.isActive ? <span className="text-emerald-700">активна</span> : <span className="text-slate-500">выключена</span>}</Td>
                            <Td>
                              <form action={toggleOfdMapping}>
                                <input type="hidden" name="mappingId" value={m.id} />
                                <button type="submit" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">{m.isActive ? "Выключить" : "Включить"}</button>
                              </form>
                            </Td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title="Импорт продаж">
                <OfdImportForm connectionId={connectionRow.id} />
              </Section>

              <Section title="Автоимпорт">
                <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
                  <div>
                    <div className="text-slate-500">Статус</div>
                    <div className="font-medium">{ofdEnabled() ? <span className="text-emerald-700">включён</span> : <span className="text-slate-500">выключен</span>} (OFD_INTEGRATIONS_ENABLED)</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Cron endpoint</div>
                    <div className="font-mono text-slate-800">POST /api/cron/ofd/daily</div>
                  </div>
                </div>
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Последняя автоматическая синхронизация</div>
                  {lastAutoRun ? (
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-3">
                      <div><span className="text-slate-500">Когда:</span> {dateFmt.format(lastAutoRun.createdAt)}</div>
                      <div><span className="text-slate-500">Период:</span> {lastAutoRun.dateFrom} — {lastAutoRun.dateTo}</div>
                      <div><span className="text-slate-500">Статус:</span> {lastAutoRun.status}</div>
                      <div><span className="text-slate-500">Найдено/Добавлено/Пропущено:</span> {lastAutoRun.foundReceipts}/{lastAutoRun.importedReceipts}/{lastAutoRun.skippedReceipts}</div>
                      <div><span className="text-slate-500">Приход:</span> {formatKopeks(lastAutoRun.totalIncomeKopeks)}</div>
                      <div><span className="text-slate-500">Ошибки:</span> {lastAutoErrorCount}{lastAutoRun.safeErrorCode ? ` (${lastAutoRun.safeErrorCode})` : ""}</div>
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500">Автоматических синхронизаций ещё не было.</div>
                  )}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Автоимпорт подтягивает продажи за вчера. Запуск выполняется внешним cron / systemd timer / scheduler,
                  который отправляет <span className="font-mono">POST /api/cron/ofd/daily</span> с секретным заголовком. Секрет в интерфейсе не отображается.
                </p>
              </Section>

              <Section title="ОФД продажи">
                <div className="mb-4 border-b border-slate-200 pb-4">
                  <OfdSyncNow />
                </div>
                <SalesBlock title="Сегодня" agg={aggFor(today, today)} clubName={clubName} />
                <SalesBlock title="Вчера" agg={aggFor(yesterday, yesterday)} clubName={clubName} />
                <SalesBlock title="Июль 2026" agg={aggFor("2026-07-01", "2026-07-31")} clubName={clubName} />
              </Section>

              <Section title="История синхронизаций">
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50"><tr><Th>Когда</Th><Th>Режим</Th><Th>Период</Th><Th>Статус</Th><Th>Найдено/Добавлено/Пропущено</Th><Th>Приход</Th><Th>Возврат</Th><Th>Ошибки</Th></tr></thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {runs.length === 0 ? <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-500">Импортов ещё не было.</td></tr> :
                        runs.map((r) => (
                          <tr key={r.id}>
                            <Td>{dateFmt.format(r.createdAt)}</Td>
                            <Td>{r.mode}</Td>
                            <Td>{r.dateFrom} — {r.dateTo}</Td>
                            <Td>{r.status}</Td>
                            <Td>{r.foundReceipts}/{r.importedReceipts}/{r.skippedReceipts}</Td>
                            <Td>{formatKopeks(r.totalIncomeKopeks)}</Td>
                            <Td>{formatKopeks(r.totalReturnKopeks)}</Td>
                            <Td>{errorCounts.get(r.id) ?? 0}</Td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Сначала сохраните подключение, затем добавьте кассы и запустите импорт.</p>
          )}
        </>
      )}
    </div>
  );
}

function SalesBlock({ title, agg, clubName }: { title: string; agg: Map<string, { income: number; cash: number; electronic: number; ret: number; net: number }>; clubName: Map<string, string> }) {
  const rows = [...agg.entries()];
  return (
    <div className="mb-4">
      <div className="mb-2 text-sm font-medium text-slate-600">{title}</div>
      {rows.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">Нет данных.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50"><tr><Th>Клуб</Th><Th>Наличные</Th><Th>Безнал</Th><Th>Возвраты</Th><Th>Итог</Th></tr></thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map(([clubId, a]) => (
                <tr key={clubId}>
                  <Td>{clubName.get(clubId) ?? "—"}</Td>
                  <Td>{formatKopeks(a.cash)}</Td>
                  <Td>{formatKopeks(a.electronic)}</Td>
                  <Td>{formatKopeks(a.ret)}</Td>
                  <Td className="font-medium text-slate-900">{formatKopeks(a.net)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">{children}</div>
    </div>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 align-top text-slate-700 ${className ?? ""}`}>{children}</td>;
}
