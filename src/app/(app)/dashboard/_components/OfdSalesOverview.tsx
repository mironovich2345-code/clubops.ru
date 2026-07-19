import Link from "next/link";
import { formatKopeks } from "@/lib/money";
import { loadOfdDashboardSummary } from "@/lib/ofd/dashboard";
import type { OfdMoneyAgg } from "@/lib/ofd/analytics";

// Managerial ОФД-продажи block for the main dashboard. Owner / general_director /
// regional_director only (gated by the caller via ofd_sales page access). Reuses the
// pure analytics library; shows aggregates only — never raw fiscal data / secrets /
// PII / cashier values. Themed for light + dark (no white blocks on dark).
export async function OfdSalesOverview({ companyId, clubIds, now }: { companyId: string; clubIds: string[]; now?: Date }) {
  const o = await loadOfdDashboardSummary(companyId, clubIds, now ?? new Date());

  return (
    <div className="mb-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">ОФД-продажи</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Фактическая выручка по чекам ОФД: сегодня, вчера, текущий месяц, статьи доходов и клубы.</p>
        </div>
        <Link href="/analytics/ofd-sales" className="shrink-0 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">Открыть подробную аналитику ОФД-продаж →</Link>
      </div>

      {!o.hasData ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Пока нет продаж по ОФД за текущий месяц. Как только чеки синхронизируются, здесь появится сводка.
        </div>
      ) : (
        <>
          {/* Top cards: Today / Yesterday / Month / Pace */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MoneyCard title="Сегодня" agg={o.today} />
            <MoneyCard title="Вчера" agg={o.yesterday} />
            <MoneyCard title="Текущий месяц" agg={o.month} highlight />
            <PaceCard pace={o.pace} />
          </div>

          {o.signals.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/40">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">Требует внимания</div>
              <ul className="space-y-1 text-sm text-amber-900 dark:text-amber-200">
                {o.signals.map((s) => (
                  <li key={s.code + s.message} className="flex gap-2"><span aria-hidden>•</span><span>{s.message}</span></li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Клубы за текущий месяц">
              {o.byClub.length === 0 ? (
                <Empty />
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        <Th>Клуб</Th><Th>Приход</Th><Th>Наличные</Th><Th>Безнал</Th><Th>Возвраты</Th><Th>Чеков</Th><Th>Ср. чек</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {o.byClub.map((c) => (
                        <tr key={c.clubId}>
                          <Td className="font-medium text-slate-800 dark:text-slate-100">{c.name}</Td>
                          <Td>{formatKopeks(c.agg.income)}</Td>
                          <Td>{formatKopeks(c.agg.cash)}</Td>
                          <Td>{formatKopeks(c.agg.electronic)}</Td>
                          <Td>{formatKopeks(c.agg.ret)}</Td>
                          <Td>{c.agg.receipts}</Td>
                          <Td>{c.agg.receipts > 0 ? formatKopeks(c.avgCheckKopeks) : "—"}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <div className="space-y-4">
              <Panel title="ООО / ИП">
                {o.byLegal.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          <Th>Юрлицо</Th><Th>Приход</Th><Th>Наличные</Th><Th>Безнал</Th><Th>Возвраты</Th><Th>Чеков</Th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {o.byLegal.map((l) => (
                          <tr key={l.legalEntityId}>
                            <Td className="font-medium text-slate-800 dark:text-slate-100">{l.name}</Td>
                            <Td>{formatKopeks(l.agg.income)}</Td>
                            <Td>{formatKopeks(l.agg.cash)}</Td>
                            <Td>{formatKopeks(l.agg.electronic)}</Td>
                            <Td>{formatKopeks(l.agg.ret)}</Td>
                            <Td>{l.agg.receipts}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel title="Статьи доходов">
                {o.categories.length === 0 ? (
                  <div className="text-sm text-slate-500 dark:text-slate-400">Номенклатура за текущий месяц пока недоступна: чеки есть, но позиции ещё не получены.</div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            <Th>Статья</Th><Th>Сумма</Th><Th>Доля</Th><Th>Позиций</Th><Th>Чеков</Th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {o.categories.map((c) => (
                            <tr key={c.code}>
                              <Td className="font-medium text-slate-800 dark:text-slate-100">{c.name}</Td>
                              <Td>{formatKopeks(c.income)}</Td>
                              <Td>{Math.round(c.share * 100)}%</Td>
                              <Td>{c.items}</Td>
                              <Td>{c.receipts}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {o.otherWarn ? (
                      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                        Есть значимая сумма в «Иное» ({Math.round(o.otherShare * 100)}%) — проверьте номенклатуру.
                      </div>
                    ) : null}
                  </>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MoneyCard({ title, agg, highlight }: { title: string; agg: OfdMoneyAgg; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${highlight ? "border-brand-200 bg-brand-50/60 dark:border-brand-900 dark:bg-brand-950/30" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"}`}>
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{title}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{formatKopeks(agg.income)}</div>
      <dl className="mt-2 space-y-0.5 text-xs">
        <MiniRow label="Наличные" value={formatKopeks(agg.cash)} />
        <MiniRow label="Безнал" value={formatKopeks(agg.electronic)} />
        <MiniRow label="Возвраты" value={formatKopeks(agg.ret)} />
        <MiniRow label="Чеков" value={String(agg.receipts)} />
      </dl>
    </div>
  );
}

function PaceCard({ pace }: { pace: { avgPerDayKopeks: number; forecastKopeks: number; daysPassed: number; daysLeft: number; daysInMonth: number } }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Темп месяца</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{formatKopeks(pace.forecastKopeks)}</div>
      <div className="text-xs text-slate-400 dark:text-slate-500">прогноз до конца месяца</div>
      <dl className="mt-2 space-y-0.5 text-xs">
        <MiniRow label="В среднем в день" value={formatKopeks(pace.avgPerDayKopeks)} />
        <MiniRow label="Прошло дней" value={`${pace.daysPassed} из ${pace.daysInMonth}`} />
        <MiniRow label="Осталось дней" value={String(pace.daysLeft)} />
      </dl>
    </div>
  );
}

function MiniRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-700 dark:text-slate-200">{value}</dd>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</div>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="text-sm text-slate-500 dark:text-slate-400">Нет данных за текущий месяц.</div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-2 py-1.5">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1.5 align-top text-slate-600 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
