import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { getCurrentAccessContext, userHasCompanyRole } from "@/lib/access";
import { ofdEnabled, ofdConfigured } from "@/lib/ofd/config";
import { toggleOfdMapping, toggleOfdConnection } from "./actions";
import { OfdConnectionForm, OfdMappingForm, OfdImportForm, OfdCheckConnection, OfdContractPicker, OfdSyncNow, OfdRecalcCategories, OfdRevenueTable, OfdNewDocsDiagnostics, OfdDocInfoDiagnostics } from "./_components/OfdForms";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Human-readable sync-run modes for the history table.
const MODE_LABELS: Record<string, string> = {
  manual_day: "Ручной импорт",
  manual_period: "Ручной импорт",
  sync_now: "Синхронизация сейчас",
  auto_daily: "Автоимпорт",
  daily: "Автоимпорт",
  backfill_july: "Загрузка периода",
};
const modeLabel = (mode: string) => MODE_LABELS[mode] ?? mode;

// Cash-register source labels (NOT a legal entity).
const REGISTER_KIND_LABELS: Record<string, string> = { club_cashbox: "Касса клуба", online_cashbox: "Онлайн-касса" };
const registerKindLabel = (kind: string | null | undefined) => REGISTER_KIND_LABELS[kind ?? "club_cashbox"] ?? "Касса клуба";

type ConnCard = { id: string; displayName: string; serverBaseUrl: string; contractNumber: string | null; authType: string; legalEntityId: string | null; isActive: boolean; hasLogin: boolean; hasPassword: boolean; hasToken: boolean };
// Static connection status derived from stored config (a live ЛК check is done by
// the "Проверить подключение" button, which can additionally surface a wrong-ЛК warning).
function connectionStatus(c: ConnCard): { label: string; tone: "ok" | "warn" | "muted" } {
  if (!c.isActive) return { label: "Отключено", tone: "muted" };
  const configured = c.authType === "integration_token" ? c.hasToken : c.hasLogin && c.hasPassword;
  if (!configured) return { label: "Не настроено", tone: "warn" };
  if (!c.contractNumber) return { label: "Требует проверки", tone: "warn" };
  return { label: "Готово к проверке", tone: "ok" };
}

export default async function OfdIntegrationPage() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/settings");
  const companyId = ctx.selectedCompanyId;
  const isAdmin = await userHasCompanyRole(ctx.user.id, companyId, ["owner", "general_director"]);
  if (!isAdmin) redirect("/settings");

  const [connectionRows, clubs, entities] = await Promise.all([
    prisma.ofdConnection.findMany({ where: { companyId, provider: "taxcom" }, orderBy: { createdAt: "asc" } }),
    prisma.club.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.legalEntity.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const legalName = new Map(entities.map((e) => [e.id, e.name]));
  const connectionIds = connectionRows.map((c) => c.id);
  const hasConnections = connectionRows.length > 0;

  // SAFE view models for the connection cards — never expose secrets, only presence.
  const connections: ConnCard[] = connectionRows.map((c) => ({
    id: c.id, displayName: c.displayName, serverBaseUrl: c.serverBaseUrl, contractNumber: c.contractNumber,
    authType: c.authType, legalEntityId: c.legalEntityId, isActive: c.isActive,
    hasLogin: Boolean(c.loginEncrypted), hasPassword: Boolean(c.passwordEncrypted), hasToken: Boolean(c.integrationTokenEncrypted),
  }));
  const connDisplay = new Map(connections.map((c) => [c.id, c.displayName]));
  const connLegal = new Map(connections.map((c) => [c.id, c.legalEntityId]));
  const legalLabelOf = (legalEntityId: string | null) => (legalEntityId ? legalName.get(legalEntityId) ?? "—" : "не указано");
  const connOptions = connections.map((c) => ({ id: c.id, label: `${c.displayName}${c.legalEntityId ? ` · ${legalName.get(c.legalEntityId) ?? ""}` : ""}` }));

  const month = new Date().toISOString().slice(0, 7); // "YYYY-MM"

  const [mappings, runs, summaries, lastAutoRun, categorySummaries] = hasConnections
    ? await Promise.all([
        prisma.ofdCashRegisterMapping.findMany({ where: { connectionId: { in: connectionIds } }, orderBy: { createdAt: "desc" } }),
        prisma.ofdSyncRun.findMany({ where: { connectionId: { in: connectionIds } }, orderBy: { createdAt: "desc" }, take: 12 }),
        prisma.ofdDailySalesSummary.findMany({ where: { companyId, provider: "taxcom" } }),
        prisma.ofdSyncRun.findFirst({ where: { connectionId: { in: connectionIds }, mode: "auto_daily" }, orderBy: { createdAt: "desc" } }),
        prisma.ofdRevenueCategoryDailySummary.findMany({ where: { companyId, provider: "taxcom", date: { startsWith: month } } }),
      ])
    : [[], [], [], null, []] as const;

  // Active kassa count per connection (for the connection cards).
  const activeMappingCount = new Map<string, number>();
  for (const m of mappings) if (m.isActive) activeMappingCount.set(m.connectionId, (activeMappingCount.get(m.connectionId) ?? 0) + 1);

  const lastAutoErrorCount = lastAutoRun ? await prisma.ofdSyncError.count({ where: { syncRunId: lastAutoRun.id } }) : 0;

  // Revenue by category for the current month (in the fixed CLUB-OPS order).
  const CATEGORY_ORDER = ["membership", "personal_training", "group_training", "extra_services", "other"] as const;
  const CATEGORY_NAMES: Record<string, string> = { membership: "Абонементы", personal_training: "Персональные тренировки", group_training: "Групповые тренировки", extra_services: "Доп. услуги", other: "Иное" };
  const catAgg = new Map<string, { income: number; ret: number; net: number; items: number; receipts: number }>();
  for (const s of categorySummaries) {
    const a = catAgg.get(s.categoryCode) ?? { income: 0, ret: 0, net: 0, items: 0, receipts: 0 };
    a.income += s.incomeTotalKopeks; a.ret += s.returnTotalKopeks; a.net += s.netTotalKopeks; a.items += s.itemCount; a.receipts += s.receiptCount;
    catAgg.set(s.categoryCode, a);
  }
  const categoryRows = CATEGORY_ORDER.filter((c) => catAgg.has(c)).map((code) => ({ code, name: CATEGORY_NAMES[code], ...catAgg.get(code)! }));
  const hasNomenclature = categorySummaries.length > 0;
  // Month has receipts (sales summary) but no nomenclature → items unavailable.
  const monthHasSales = summaries.some((s) => s.date.startsWith(month) && (s.incomeTotalKopeks > 0 || s.returnTotalKopeks > 0));

  // Top-20 unrecognized nomenclature (category=other) for the current month.
  const unrecognized = hasConnections
    ? await prisma.ofdReceiptItem.groupBy({
        by: ["normalizedItemName"],
        where: { companyId, provider: "taxcom", revenueCategoryCode: "other", date: { startsWith: month } },
        _sum: { totalKopeks: true },
        _count: { _all: true },
        orderBy: { _sum: { totalKopeks: "desc" } },
        take: 20,
      })
    : [];

  // Drilldown detail for the category table: group the current month's OfdReceiptItem
  // by (revenueCategoryCode, normalizedItemName) — SAFE columns only (no fiscalSign /
  // raw JSON / PII). Same scope as the category summary above (company + taxcom + month).
  type DetailRow = { normalizedName: string; net: number; income: number; itemCount: number; receiptCount: number; examples: string[] };
  const categoryDetails: Record<string, DetailRow[]> = {};
  if (hasConnections) {
    const detailItems = await prisma.ofdReceiptItem.findMany({
      where: { companyId, provider: "taxcom", date: { startsWith: month } },
      select: { revenueCategoryCode: true, normalizedItemName: true, itemName: true, totalKopeks: true, operationType: true, receiptImportId: true },
    });
    const byCat = new Map<string, Map<string, { income: number; ret: number; itemCount: number; receipts: Set<string>; examples: string[]; seen: Set<string> }>>();
    for (const it of detailItems) {
      let cat = byCat.get(it.revenueCategoryCode);
      if (!cat) { cat = new Map(); byCat.set(it.revenueCategoryCode, cat); }
      let row = cat.get(it.normalizedItemName);
      if (!row) { row = { income: 0, ret: 0, itemCount: 0, receipts: new Set(), examples: [], seen: new Set() }; cat.set(it.normalizedItemName, row); }
      if (it.operationType === "income") row.income += it.totalKopeks; else row.ret += it.totalKopeks;
      row.itemCount += 1;
      row.receipts.add(it.receiptImportId);
      const ex = (it.itemName ?? "").slice(0, 160);
      if (ex && !row.seen.has(ex) && row.examples.length < 3) { row.examples.push(ex); row.seen.add(ex); }
    }
    for (const [code, rows] of byCat) {
      categoryDetails[code] = [...rows.entries()]
        .map(([normalizedName, r]) => ({ normalizedName, net: r.income - r.ret, income: r.income, itemCount: r.itemCount, receiptCount: r.receipts.size, examples: r.examples }))
        .sort((a, b) => b.net - a.net);
    }
  }

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

          {/* 1) Подключения Такском */}
          <Section title="Подключения Такском">
            {connections.length === 0 ? (
              <p className="mb-4 text-sm text-slate-500">Пока нет ни одного подключения Такском. Добавьте первое ниже. У сети может быть несколько подключений — например, ООО и ИП.</p>
            ) : (
              <div className="space-y-3">
                {connections.map((c) => {
                  const st = connectionStatus(c);
                  const tone = st.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : st.tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-slate-50 text-slate-500";
                  return (
                    <div key={c.id} className="rounded-lg border border-slate-200 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{c.displayName}</div>
                          <div className="mt-0.5 text-sm text-slate-600">Юрлицо: {legalLabelOf(c.legalEntityId)}{" · "}Договор: <span className="font-mono">{c.contractNumber ?? "—"}</span></div>
                          <div className="mt-1 text-xs text-slate-500">Активных касс: {activeMappingCount.get(c.id) ?? 0}</div>
                        </div>
                        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}>{st.label}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
                        <OfdCheckConnection connectionId={c.id} />
                        <form action={toggleOfdConnection}>
                          <input type="hidden" name="connectionId" value={c.id} />
                          <button type="submit" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">{c.isActive ? "Отключить" : "Включить"}</button>
                        </form>
                      </div>
                      <OfdContractPicker connectionId={c.id} />
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm font-medium text-brand-700">Изменить подключение</summary>
                        <div className="mt-3 border-t border-slate-100 pt-3">
                          <OfdConnectionForm connection={c} clubs={clubs} entities={entities} />
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            )}
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-brand-700">Добавить подключение Такском</summary>
              <div className="mt-3 border-t border-slate-200 pt-4">
                <OfdConnectionForm connection={null} clubs={clubs} entities={entities} />
              </div>
            </details>
          </Section>

          {hasConnections ? (
            <>
              {/* 2) Кассы ККТ */}
              <Collapsible title="Кассы ККТ" subtitle="ФН, юрлицо, клуб и тип кассы">
                <OfdMappingForm connections={connOptions} clubs={clubs} />
                <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50"><tr><Th>ФН</Th><Th>РНМ ККТ</Th><Th>Название</Th><Th>Подключение</Th><Th>Юрлицо</Th><Th>Клуб</Th><Th>Тип кассы</Th><Th>Статус</Th><Th>Действия</Th></tr></thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {mappings.length === 0 ? <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-500">Кассы не сопоставлены.</td></tr> :
                        mappings.map((m) => (
                          <tr key={m.id}>
                            <Td>{m.fnNumber}</Td>
                            <Td>{m.kktRegNumber ?? "—"}</Td>
                            <Td>{m.kktName ?? "—"}</Td>
                            <Td>{connDisplay.get(m.connectionId) ?? "—"}</Td>
                            <Td>{legalLabelOf(m.legalEntityId ?? connLegal.get(m.connectionId) ?? null)}</Td>
                            <Td>{clubName.get(m.clubId) ?? "—"}</Td>
                            <Td>{registerKindLabel(m.registerKind)}</Td>
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
              </Collapsible>

              {/* 3) Синхронизация продаж */}
              <Collapsible title="Синхронизация продаж" subtitle="Ручная синхронизация, импорт за период и статус автоимпорта">
                <OfdSyncNow />
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <div className="mb-2 text-sm font-medium text-slate-700">Импорт за период</div>
                  <OfdImportForm connections={connOptions} />
                </div>
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <div className="mb-2 text-sm font-medium text-slate-700">Автоимпорт</div>
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
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
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
                    Автоимпорт подтягивает продажи за вчера по всем активным подключениям. Запуск выполняется внешним cron / systemd timer,
                    который отправляет <span className="font-mono">POST /api/cron/ofd/daily</span> с секретным заголовком. Секрет в интерфейсе не отображается.
                  </p>
                </div>
              </Collapsible>

              {/* 4) ОФД продажи */}
              <Collapsible title="ОФД продажи" subtitle="Краткий итог по сегодняшним и вчерашним чекам">
                <SalesBlock title="Сегодня" agg={aggFor(today, today)} clubName={clubName} />
                <SalesBlock title="Вчера" agg={aggFor(yesterday, yesterday)} clubName={clubName} />
                <SalesBlock title="Июль 2026" agg={aggFor("2026-07-01", "2026-07-31")} clubName={clubName} />
                <p className="mt-1 text-xs text-slate-500">Источник чеков задаётся в настройках кассы: «Касса клуба» или «Онлайн-касса». Онлайн-оплаты попадают в продажи выбранного клуба, но отмечены как онлайн-касса.</p>
                <Link href="/analytics/ofd-sales" className="mt-3 inline-block text-sm font-medium text-brand-700 hover:underline">Подробная аналитика ОФД-продаж →</Link>
              </Collapsible>

              {/* 5) Статьи доходов ОФД */}
              <Collapsible title="Статьи доходов ОФД" subtitle="Абонементы, персональные тренировки, группы, доп. услуги и Иное">
                <div className="mb-2 text-sm font-medium text-slate-600">Текущий месяц ({month})</div>
                {!hasNomenclature ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {monthHasSales
                      ? "Номенклатура пока недоступна: ОФД вернул суммы чеков, но не вернул позиции товаров/услуг."
                      : "Нет данных по статьям доходов за текущий месяц."}
                  </div>
                ) : (
                  <OfdRevenueTable rows={categoryRows} details={categoryDetails} />
                )}
                {unrecognized.length > 0 ? (
                  <div className="mt-6">
                    <div className="mb-2 text-sm font-medium text-slate-600">Требуют проверки — нераспознанная номенклатура (топ-20, «Иное»)</div>
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="min-w-full divide-y divide-slate-200 text-sm">
                        <thead className="bg-slate-50"><tr><Th>Позиция</Th><Th>Сумма</Th><Th>Кол-во</Th></tr></thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {unrecognized.map((u, i) => (
                            <tr key={i}>
                              <Td>{u.normalizedItemName}</Td>
                              <Td>{formatKopeks(u._sum.totalKopeks ?? 0)}</Td>
                              <Td>{u._count._all}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">Эти позиции попали в «Иное». Позже для них можно настроить правила статей доходов.</p>
                  </div>
                ) : null}
                <OfdRecalcCategories />
              </Collapsible>

              {/* 6) История синхронизаций (свёрнута по умолчанию) */}
              <Collapsible title="История синхронизаций" subtitle="Последние запуски импорта ОФД">
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50"><tr><Th>Когда</Th><Th>Режим</Th><Th>Период</Th><Th>Статус</Th><Th>Найдено/Добавлено/Пропущено</Th><Th>Приход</Th><Th>Возврат</Th><Th>Ошибки</Th></tr></thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {runs.length === 0 ? <tr><td colSpan={8} className="px-4 py-6 text-center text-slate-500">Импортов ещё не было.</td></tr> :
                        runs.map((r) => (
                          <tr key={r.id}>
                            <Td>{dateFmt.format(r.createdAt)}</Td>
                            <Td>{modeLabel(r.mode)}</Td>
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
              </Collapsible>

              {/* 7) Расширенная диагностика (свёрнута по умолчанию) — технические
                  NewDocuments / DocumentInfo / ФН / ФД / shape-диагностика только здесь. */}
              <Collapsible title="Расширенная диагностика" subtitle="Технический блок для отладки Taxcom и DocumentInfo">
                <div className="mb-2 text-sm font-medium text-slate-700">Проверить структуру NewDocuments</div>
                <p className="mb-3 text-xs text-slate-500">
                  Проверяет, отдаёт ли метод Такском <span className="font-mono">GET /API/v2/NewDocuments</span> позиции чеков (номенклатуру).
                  Возвращает только структуру ответа — без содержимого и без сохранения сырого JSON.
                </p>
                <OfdNewDocsDiagnostics connectionId={connections[0].id} />
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <div className="mb-2 text-sm font-medium text-slate-700">Диагностика конкретного чека DocumentInfo</div>
                  <p className="mb-3 text-xs text-slate-500">Показывает структуру чека и факт наличия полей кассира (без ФИО/ИНН).</p>
                  <OfdDocInfoDiagnostics connectionId={connections[0].id} />
                </div>
              </Collapsible>
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

// Native <details> collapsible (same pattern as /collections): title always visible,
// keyboard-accessible, safe for server-action forms, themed centrally for light/dark.
// Collapsed by default — used for technical/rarely-needed blocks.
function Collapsible({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <details className="group mb-8 rounded-lg border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div>
          <div className="text-sm font-semibold text-slate-700">{title}</div>
          {subtitle ? <div className="mt-0.5 text-xs text-slate-500">{subtitle}</div> : null}
        </div>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"><path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </summary>
      <div className="border-t border-slate-200 px-5 pb-5 pt-4">{children}</div>
    </details>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 align-top text-slate-700 ${className ?? ""}`}>{children}</td>;
}
