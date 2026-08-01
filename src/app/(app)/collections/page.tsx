import Link from "next/link";
import { redirect } from "next/navigation";
import { CompactPageHeader, MobileDataCard } from "@/components/mobile/density";
import { MonthNav } from "@/components/mobile/MonthNav";
import { AccordionGroup, AccordionItem } from "./_components/SingleAccordion";
import { formatKopeks } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational, canManageControlSnapshot, type Role } from "@/lib/auth";
import { legalEntityTypeLabel } from "@/lib/legal-entities";
import { loadClubCashBalances } from "@/lib/cash-collections";
import { getEligibleRegionalDirectorsForClub, getSnapshotTimeline } from "@/lib/cash-transfers";
import { loadCollectionsHistory, type UnifiedHistoryRow } from "@/lib/collections-history";
import type { CashBalances } from "@/lib/cash-balances";
import {
  buildReconciliationTargets,
  getReconciliationsForScope,
  canSubmitReconciliation,
  canRegionalReview,
  canAccountingReview,
  displayReconStatus,
  isReconciliationOverdue,
} from "@/lib/cash-reconciliation";
import { CashSyncButtons, CollectionForm, WithdrawalForm, OtherIncomeForm, OpeningBalanceForm, ReviewButtons, CancelButton } from "./_components/CollectionForms";
import { RegionalTransferForm, TransferConfirmButton, TransferCancelButton, SnapshotCorrectionButton, SnapshotCancelButton } from "./_components/CashTransferForms";
import { ReconciliationForm, type ReconEntity } from "./_components/ReconciliationForm";
import { ReconciliationReview } from "./_components/ReconciliationReview";

export const dynamic = "force-dynamic";

const dfmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const STATUS_LABELS: Record<string, string> = {
  pending_accountant_review: "На проверке", pending_review: "На проверке",
  pending_confirmation: "Ожидает подтверждения", approved: "Подтверждено", confirmed: "Подтверждено",
  rejected: "Отклонено", cancelled: "Отменено", canceled: "Отменено", draft: "Черновик",
  active: "Активна", superseded: "Скорректирована", awaiting_input: "Ожидает ввода", closed: "Закрыто",
};
const SOURCE_LABELS: Record<string, string> = { regional: "Региональный директор", owner: "Собственник", general_director: "Генеральный директор", other: "Другое", ip: "ИП" };
const TYPE_FILTERS = [
  { key: "", label: "Все типы" }, { key: "reconciliation", label: "Сверки" }, { key: "snapshot", label: "Контрольные точки" },
  { key: "collection", label: "Инкассации ООО" }, { key: "withdrawal", label: "Изъятия ООО→ИП" }, { key: "other_income", label: "Приход «Иное»" }, { key: "transfer", label: "Передачи регионалу" },
];

function canReview(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "accountant" || r === "chief_accountant" || r === "owner" || r === "general_director" || r === "regional_director");
}

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ month?: string; type?: string; entity?: string; status?: string; author?: string }> }) {
  await requirePageAccess("collections");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/dashboard");
  const companyId = ctx.selectedCompanyId;
  const clubIds = ctx.allowedClubIds;
  const roles = ctx.effectiveRoles;
  const mayCreate = canCreateOperational(roles);
  const maySnapshot = canManageControlSnapshot(roles); // shared guard (UI mirror of the server action)
  const mayReview = canReview(roles);
  const myUserId = ctx.user.id;
  const today = ymd(new Date());
  const now = new Date();

  const sp = await searchParams;
  // Selected history month (?month=YYYY-MM; default current). Filters ONLY the history +
  // monthly totals — the current-balance cards below always show "Сейчас".
  const curMonth = monthKey(now);
  const selectedMonth = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : curMonth;
  const [my, mm] = selectedMonth.split("-").map(Number);
  const monthStart = new Date(my, mm - 1, 1);
  const monthLabel = cap(monthFmt.format(monthStart));
  const prevMonth = monthKey(new Date(my, mm - 2, 1));
  const nextMonth = monthKey(new Date(my, mm, 1));
  const fType = sp.type ?? ""; const fEntity = sp.entity ?? ""; const fStatus = sp.status ?? ""; const fAuthor = sp.author ?? "";
  const qs = (over: Record<string, string>) => {
    const p = new URLSearchParams({ ...(fType ? { type: fType } : {}), ...(fEntity ? { entity: fEntity } : {}), ...(fStatus ? { status: fStatus } : {}), ...(fAuthor ? { author: fAuthor } : {}), month: selectedMonth, ...over });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/collections?${p.toString()}`;
  };

  const clubs = clubIds.length ? await prisma.club.findMany({ where: { companyId, id: { in: clubIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const [perClub, reconTargets, reconHistory, directorsPairs, hist] = await Promise.all([
    Promise.all(clubs.map(async (c) => ({ club: c, res: await loadClubCashBalances(companyId, c.id) }))),
    canSubmitReconciliation(roles) && clubs.length ? Promise.all(clubs.map(async (c) => ({ club: c, ...(await buildReconciliationTargets(companyId, c.id, now)) }))) : Promise.resolve([]),
    getReconciliationsForScope(companyId, clubIds, { limit: 40 }),
    clubs.length ? Promise.all(clubs.map(async (c) => [c.id, await getEligibleRegionalDirectorsForClub(companyId, c.id)] as const)) : Promise.resolve([]),
    loadCollectionsHistory(companyId, clubIds, selectedMonth),
  ]);
  const directorsByClub: Record<string, { id: string; name: string }[]> = Object.fromEntries(directorsPairs);
  // Control-point version timelines per club + legal entity (active + superseded + cancelled).
  const timelines = (
    await Promise.all(
      perClub.flatMap(({ club, res }) =>
        [res.oooId ? { leId: res.oooId, type: "ooo" as const } : null, res.ipId ? { leId: res.ipId, type: "ip" as const } : null]
          .filter((x): x is { leId: string; type: "ooo" | "ip" } => Boolean(x))
          .map(async (e) => ({ clubId: club.id, clubName: club.name, entityType: e.type, rows: await getSnapshotTimeline(club.id, e.leId) })),
      ),
    )
  ).filter((t) => t.rows.length > 0);
  const mayRegionalRecon = canRegionalReview(roles);
  const mayAccountingRecon = canAccountingReview(roles);

  // Apply the compact history filters (server-side, over the month's rows). Filters change
  // ONLY the history rows — never the current-balance cards.
  const filteredRows = hist.rows.filter((r) =>
    (!fType || r.kind === fType) && (!fEntity || r.entity === fEntity) &&
    (!fStatus || r.status === fStatus) && (!fAuthor || r.createdById === fAuthor));

  // Author + status option pools from the month's rows.
  const authorIds = [...new Set([...hist.rows.map((r) => r.createdById), ...hist.rows.map((r) => r.confirmedById).filter((x): x is string => Boolean(x)), ...timelines.flatMap((t) => t.rows.map((r) => r.createdById))].filter(Boolean))];
  const authors = authorIds.length ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } }) : [];
  const authorName = new Map(authors.map((a) => [a.id, a.name]));
  const statusOptions = [...new Set(hist.rows.map((r) => r.status))];
  const authorOptions = [...new Set(hist.rows.map((r) => r.createdById))].map((id) => ({ id, name: authorName.get(id) ?? "—" }));
  const myManagerClubIds = new Set(
    clubIds.length ? (await prisma.clubUserAccess.findMany({ where: { userId: myUserId, role: "manager", clubId: { in: clubIds } }, select: { clubId: true } })).map((r) => r.clubId) : [],
  );

  const signCell = (r: UnifiedHistoryRow) =>
    r.sign === "fact" ? <span className="text-slate-500">Факт {formatKopeks(r.amountKopeks)}</span>
      : r.sign === "in" ? <span className="font-medium text-emerald-600">+{formatKopeks(r.amountKopeks)}</span>
        : <span className="font-medium text-rose-600">−{formatKopeks(r.amountKopeks)}</span>;
  const counterpartyText = (r: UnifiedHistoryRow) => r.kind === "other_income" ? (SOURCE_LABELS[r.counterparty ?? ""] ?? r.counterparty ?? "—") : (r.counterparty ?? "—");
  // Row actions preserved from the old history: review/cancel for collection/withdrawal/
  // other-income; confirm/cancel for a pending transfer.
  const CANCELABLE: Record<string, string[]> = { collection: ["draft", "pending_accountant_review"], withdrawal: ["draft", "pending_review"], other_income: ["draft", "pending_review"] };
  const rowActions = (r: UnifiedHistoryRow): React.ReactNode => {
    if (r.kind === "transfer") {
      if (r.status !== "pending_confirmation") return "—";
      return (
        <div className="flex flex-wrap gap-2">
          {myManagerClubIds.has(r.clubId) ? <TransferConfirmButton id={r.id} /> : null}
          {(r.createdById === myUserId || myManagerClubIds.has(r.clubId)) ? <TransferCancelButton id={r.id} /> : null}
        </div>
      );
    }
    if (r.kind === "collection" || r.kind === "withdrawal" || r.kind === "other_income") {
      const isPending = r.status === "pending_accountant_review" || r.status === "pending_review";
      const canCancel = (CANCELABLE[r.kind] ?? []).includes(r.status) && (r.createdById === myUserId || mayReview);
      if (!isPending && !canCancel) return "—";
      return (
        <div className="flex flex-wrap items-start gap-2">
          {mayReview && isPending ? <ReviewButtons id={r.id} kind={r.kind} /> : null}
          {canCancel ? <CancelButton id={r.id} kind={r.kind} /> : null}
        </div>
      );
    }
    return "—";
  };

  return (
    <div className="mx-auto max-w-5xl">
      {/* 1. Header + club/period */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <CompactPageHeader title="Инкассация" subtitle="Наличные ООО и ИП. Текущие остатки — «Сейчас»; история и итоги — за выбранный месяц." />
        <div className="w-full sm:w-72">
          <MonthNav prevHref={qs({ month: prevMonth })} nextHref={qs({ month: nextMonth })} label={monthLabel} />
        </div>
      </div>
      <p className="mb-4 text-xs text-slate-400">Выбор месяца меняет только историю и месячные показатели — карточки «Фактический остаток сейчас» остаются текущими.</p>

      {/* 2. «Фактические деньги» — первый рабочий блок (open, not collapsed) */}
      <Section title="Фактические деньги — сверка наличных" subtitle="Ежедневный пересчёт реальных денег в кассе (это НЕ контрольная точка)">
        {canSubmitReconciliation(roles) && reconTargets.length > 0 ? (
          <div className="mb-5 space-y-5">
            {reconTargets.map(({ club, businessDate, entities }) => {
              const reconEntities: ReconEntity[] = entities.map((e) => ({ legalEntityType: e.legalEntityType, name: e.name, ofdCashRevenueKopeks: e.ofdCashRevenueKopeks, expectedCashBalanceKopeks: e.expectedCashBalanceKopeks, actualKopeks: e.existing ? e.existing.actualCashBalanceKopeks : null, status: e.existing?.status ?? null }));
              return (
                <div key={club.id}>
                  {clubs.length > 1 ? <div className="mb-2 text-xs font-semibold text-slate-600">Клуб: {club.name}</div> : null}
                  <ReconciliationForm clubId={club.id} businessDateLabel={dfmt.format(businessDate)} entities={reconEntities} />
                </div>
              );
            })}
          </div>
        ) : null}
        <CashSyncButtons />
        <p className="mt-2 text-xs text-slate-500">Синхронизация ОФД-наличных. После неё пересчитываются вчера, период и фактический остаток.</p>
      </Section>

      {/* 3. Карточки текущих остатков ООО/ИП (Сейчас) */}
      {perClub.length === 0 ? (
        <div className="mb-8 rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500 shadow-sm">Нет доступных клубов.</div>
      ) : (
        perClub.map(({ club, res }) => (
          <Section key={club.id} title={`Остатки сейчас · ${club.name}`}>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2"><OooCard b={res.balances} /><IpCard b={res.balances} /></div>
          </Section>
        ))
      )}

      <AccordionGroup>
      {/* 4. Контрольный остаток */}
      <AccordionItem id="control" title="Контрольный остаток" subtitle="Фактическая сумма наличных на дату — новая база расчёта (это НЕ ежедневная сверка)">
        <p className="mb-3 text-xs text-slate-500">Текущий остаток считается от последней применимой контрольной точки (effectiveDate ≤ сегодня) плюс движения после неё. Можно добавить более раннюю точку — она меняет только исторический интервал до следующей точки. Append-only: сумма правится только через «Скорректировать»; «Отменить» делает точку неприменимой, но не удаляет её.</p>
        {maySnapshot ? <OpeningBalanceForm clubs={clubs} today={today} /> : <p className="text-xs text-slate-400">Создавать контрольную точку может управляющий клуба, региональный директор с доступом к клубу или бухгалтер с доступом к компании.</p>}
        {timelines.length > 0 ? (
          <div className="mt-5 space-y-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Хронология контрольных точек</div>
            {timelines.map((t) => (
              <div key={`${t.clubId}-${t.entityType}`}>
                <div className="mb-2 text-xs font-medium text-slate-600">{t.clubName} · {legalEntityTypeLabel(t.entityType)}</div>
                <div className="hidden overflow-x-auto rounded-lg border border-slate-200 lg:block">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50"><tr><Th>Дата (effective)</Th><Th>Сумма</Th><Th>Период</Th><Th>Версия</Th><Th>Статус</Th><Th>Автор</Th><Th>Причина</Th><Th>Действия</Th></tr></thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {t.rows.map((r) => (
                        <tr key={r.id} className={r.status !== "active" ? "text-slate-400" : undefined}>
                          <Td>{dfmt.format(r.snapshotDate)}</Td>
                          <Td>{formatKopeks(r.actualBalanceKopeks)}</Td>
                          <Td>{r.status === "active" ? `с ${r.effectiveFrom}${r.effectiveTo ? ` до ${r.effectiveTo}` : " по н.в."}` : "—"}</Td>
                          <Td>v{r.version}</Td>
                          <Td>{r.status === "active" ? "активна" : r.status === "cancelled" ? "отменена" : "скорректирована"}</Td>
                          <Td>{authorName.get(r.createdById) ?? "—"}</Td>
                          <Td>{r.cancellationReason ?? r.correctionReason ?? r.comment ?? "—"}</Td>
                          <Td>{maySnapshot && r.status === "active" ? <div className="flex flex-wrap gap-2"><SnapshotCorrectionButton snapshotId={r.id} /><SnapshotCancelButton snapshotId={r.id} /></div> : "—"}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-3 lg:hidden">
                  {t.rows.map((r) => (
                    <MobileDataCard key={r.id} title={`${dfmt.format(r.snapshotDate)} · v${r.version}`}
                      badge={<span className="text-xs font-medium text-[var(--text-muted)]">{r.status === "active" ? "активна" : r.status === "cancelled" ? "отменена" : "скорректирована"}</span>}
                      rows={[
                        { label: "Сумма", value: formatKopeks(r.actualBalanceKopeks), strong: true },
                        { label: "Период", value: r.status === "active" ? `с ${r.effectiveFrom}${r.effectiveTo ? ` до ${r.effectiveTo}` : " — н.в."}` : "—" },
                        { label: "Автор", value: authorName.get(r.createdById) ?? "—" },
                        ...(r.cancellationReason || r.correctionReason || r.comment ? [{ label: "Причина", value: r.cancellationReason ?? r.correctionReason ?? r.comment ?? "" }] : []),
                      ]}
                      footer={maySnapshot && r.status === "active" ? <div className="flex flex-wrap gap-2"><SnapshotCorrectionButton snapshotId={r.id} /><SnapshotCancelButton snapshotId={r.id} /></div> : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </AccordionItem>
      </AccordionGroup>

      {/* 5. Операции с наличными — разделены на ООО и ИП */}
      {mayCreate ? (
        <div className="mt-5">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Операции с наличными</h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">ООО</div>
              <AccordionGroup>
                <AccordionItem id="collect" title="Инкассировать ООО" subtitle="Сдать наличные ООО. Уменьшает остаток ООО"><CollectionForm clubs={clubs} today={today} /></AccordionItem>
                <AccordionItem id="withdraw" title="Изъять из ООО в ИП" subtitle="Перенос наличных из ООО в ИП. Не продажа и не доход"><WithdrawalForm clubs={clubs} today={today} /></AccordionItem>
              </AccordionGroup>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">ИП</div>
              <AccordionGroup>
                <AccordionItem id="other" title="Пополнить ИП — приход «Иное»" subtitle="Внесение наличных от регионала/собственника/директора. Это и есть возврат денег от регионала"><OtherIncomeForm clubs={clubs} today={today} /></AccordionItem>
                <AccordionItem id="transfer" title="Передать деньги региональному директору" subtitle="Наличные ИП переданы регионалу. Уменьшает остаток ИП только после подтверждения управляющим"><RegionalTransferForm clubs={clubs} directorsByClub={directorsByClub} today={today} /></AccordionItem>
              </AccordionGroup>
            </div>
          </div>
        </div>
      ) : null}

      {/* 6. Единая история операций (за выбранный месяц, с фильтрами) */}
      <div className="mt-6">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-700">История операций · {monthLabel}</h2>
          <span className="text-xs text-slate-400">За выбранный месяц · всё движение наличных</span>
        </div>

        {/* Monthly totals (за выбранный месяц) */}
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniStat label="ОФД нал. ООО" value={formatKopeks(hist.totals.ofdCashOooKopeks)} />
          <MiniStat label="ОФД нал. ИП" value={formatKopeks(hist.totals.ofdCashIpKopeks)} />
          <MiniStat label="Инкассации" value={formatKopeks(hist.totals.collectionsKopeks)} />
          <MiniStat label="Изъятия ООО→ИП" value={formatKopeks(hist.totals.withdrawalsKopeks)} />
          <MiniStat label="Приход «Иное»" value={formatKopeks(hist.totals.otherIncomeKopeks)} />
          <MiniStat label="Передачи (подтв.)" value={formatKopeks(hist.totals.transfersConfirmedKopeks)} />
          <MiniStat label="Расходы ИП (нал.)" value={formatKopeks(hist.totals.ipCashExpensesKopeks)} />
          <MiniStat label="Сверок" value={String(hist.totals.reconciliationsCount)} />
        </div>

        {/* Compact filters (GET). Change only the history rows, not the balances. */}
        <form method="get" action="/collections" className="mb-3 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-white p-3 min-[420px]:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
          <input type="hidden" name="month" value={selectedMonth} />
          <FilterSelect name="type" value={fType} label="Тип" options={TYPE_FILTERS.map((t) => ({ v: t.key, l: t.label }))} />
          <FilterSelect name="entity" value={fEntity} label="Юрлицо" options={[{ v: "", l: "ООО и ИП" }, { v: "ooo", l: "ООО" }, { v: "ip", l: "ИП" }]} />
          <FilterSelect name="status" value={fStatus} label="Статус" options={[{ v: "", l: "Все статусы" }, ...statusOptions.map((s) => ({ v: s, l: STATUS_LABELS[s] ?? s }))]} />
          <FilterSelect name="author" value={fAuthor} label="Автор" options={[{ v: "", l: "Все авторы" }, ...authorOptions.map((a) => ({ v: a.id, l: a.name }))]} />
          <div className="flex items-end gap-2">
            <button type="submit" className="min-h-[44px] rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">Показать</button>
            <Link href={`/collections?month=${selectedMonth}`} className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Сбросить</Link>
          </div>
        </form>

        {/* Active filter chips */}
        {(fType || fEntity || fStatus || fAuthor) ? (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {fType ? <Chip label={`Тип: ${TYPE_FILTERS.find((t) => t.key === fType)?.label ?? fType}`} /> : null}
            {fEntity ? <Chip label={`Юрлицо: ${fEntity.toUpperCase()}`} /> : null}
            {fStatus ? <Chip label={`Статус: ${STATUS_LABELS[fStatus] ?? fStatus}`} /> : null}
            {fAuthor ? <Chip label={`Автор: ${authorName.get(fAuthor) ?? "—"}`} /> : null}
          </div>
        ) : null}

        {filteredRows.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">Операций за выбранный месяц нет.</div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto rounded-lg border border-slate-200 lg:block">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr><Th>Дата</Th><Th>Тип</Th><Th>Юрлицо</Th><Th>Сумма</Th><Th>Клуб</Th><Th>Источник/получатель</Th><Th>Статус</Th><Th>Автор</Th><Th>Подтвердил</Th><Th>Действия</Th></tr></thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredRows.map((r) => (
                    <tr key={`${r.kind}-${r.id}`}>
                      <Td>{dfmt.format(r.effectiveDate)}</Td>
                      <Td>{r.typeLabel}</Td>
                      <Td>{r.entity ? r.entity.toUpperCase() : "—"}</Td>
                      <Td>{signCell(r)}</Td>
                      <Td>{clubName.get(r.clubId) ?? "—"}</Td>
                      <Td>{counterpartyText(r)}{r.documents ? ` · 📎${r.documents}` : ""}</Td>
                      <Td>{STATUS_LABELS[r.status] ?? r.status}</Td>
                      <Td>{authorName.get(r.createdById) ?? "—"}</Td>
                      <Td>{r.confirmedById ? authorName.get(r.confirmedById) ?? "—" : "—"}</Td>
                      <Td>{rowActions(r)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="space-y-3 lg:hidden">
              {filteredRows.map((r) => (
                <MobileDataCard key={`m-${r.kind}-${r.id}`} title={`${dfmt.format(r.effectiveDate)} · ${r.typeLabel}`}
                  badge={<span className="text-xs font-medium text-[var(--text-muted)]">{STATUS_LABELS[r.status] ?? r.status}</span>}
                  rows={[
                    { label: "Сумма", value: r.sign === "fact" ? `Факт ${formatKopeks(r.amountKopeks)}` : r.sign === "in" ? `+${formatKopeks(r.amountKopeks)}` : `−${formatKopeks(r.amountKopeks)}`, strong: true, tone: r.sign === "out" ? "danger" as const : r.sign === "in" ? "success" as const : undefined },
                    { label: "Юрлицо", value: r.entity ? r.entity.toUpperCase() : "—" },
                    { label: "Клуб", value: clubName.get(r.clubId) ?? "—" },
                    ...(r.counterparty ? [{ label: "Источник/получатель", value: counterpartyText(r) }] : []),
                    { label: "Автор", value: authorName.get(r.createdById) ?? "—" },
                    ...(r.confirmedById ? [{ label: "Подтвердил", value: authorName.get(r.confirmedById) ?? "—" }] : []),
                  ]}
                  footer={(() => { const a = rowActions(r); return a === "—" ? undefined : a; })()}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Recon review history (kept; accounting/regional review actions) */}
      {reconHistory.length > 0 ? (
        <AccordionGroup>
          <AccordionItem id="recon-history" title="Сверки — проверка и закрытие" subtitle="История ежедневных сверок и их согласование">
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr><Th>Дата</Th><Th>Клуб</Th><Th>Юрлицо</Th><Th>Ожидалось</Th><Th>Факт</Th><Th>Расхожд.</Th><Th>Статус</Th><Th>Кто</Th><Th>Действия</Th></tr></thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {reconHistory.map((r) => {
                    const overdue = isReconciliationOverdue(r.status, r.businessDate, now);
                    const needsRegional = r.differenceKopeks !== 0 && !r.regionalReviewedById && r.status !== "closed";
                    const needsAccounting = r.status !== "closed" && (r.differenceKopeks === 0 || Boolean(r.regionalReviewedById));
                    return (
                      <tr key={r.id} className={overdue ? "bg-amber-50" : r.differenceKopeks !== 0 && r.status !== "closed" ? "bg-rose-50/40" : undefined}>
                        <Td>{dfmt.format(r.businessDate)}</Td><Td>{clubName.get(r.clubId) ?? "—"}</Td><Td>{r.legalEntityType.toUpperCase()}</Td>
                        <Td>{formatKopeks(r.expectedCashBalanceKopeks)}</Td><Td>{formatKopeks(r.actualCashBalanceKopeks)}</Td>
                        <Td><span className={r.differenceKopeks !== 0 ? "font-semibold text-rose-600" : "text-emerald-600"}>{formatKopeks(r.differenceKopeks)}</span></Td>
                        <Td>{displayReconStatus(r, now)}</Td><Td>{authorName.get(r.submittedById ?? "") ?? "—"}</Td>
                        <Td>{(mayRegionalRecon || mayAccountingRecon) && r.status !== "closed" && r.status !== "awaiting_input" ? <ReconciliationReview reconciliationId={r.id} canRegional={mayRegionalRecon} canAccounting={mayAccountingRecon} needsRegional={needsRegional} needsAccounting={needsAccounting} /> : "—"}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </AccordionItem>
        </AccordionGroup>
      ) : null}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-2.5"><div className="truncate text-[11px] text-slate-500">{label}</div><div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900">{value}</div></div>;
}
function FilterSelect({ name, value, label, options }: { name: string; value: string; label: string; options: { v: string; l: string }[] }) {
  return (
    <label className="block min-w-0 lg:w-44">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      <select name={name} defaultValue={value} className="input w-full">{options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
    </label>
  );
}
function Chip({ label }: { label: string }) {
  return <span className="inline-flex items-center rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">{label}</span>;
}
function OpeningWarning({ set }: { set: boolean }) {
  if (set) return null;
  return <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Начальный остаток не задан. Укажите контрольный остаток кассы, чтобы расчёт был точным. Ниже — расчётный остаток от 0 ₽.</div>;
}
function OooCard({ b }: { b: CashBalances }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-medium text-slate-500">Наличные ООО</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{formatKopeks(b.cashOooFactBalance)}</div>
      <div className="mt-1 text-xs text-slate-400">{b.cashOooOpeningSet ? "Фактический остаток сейчас" : "Расчётный остаток от 0 ₽"}</div>
      <OpeningWarning set={b.cashOooOpeningSet} />
      <dl className="mt-3 space-y-1 text-sm">
        <Row label={`Контрольный остаток${b.cashOooOpeningDate ? ` (${b.cashOooOpeningDate})` : ""}`} value={b.cashOooOpeningSet ? formatKopeks(b.cashOooOpening) : "не задан"} />
        <Row label="Приход ООО вчера (ОФД)" value={formatKopeks(b.cashOooOfdYesterday)} />
        <Row label="Приход ООО сегодня (ОФД)" value={formatKopeks(b.cashOooOfdToday)} />
        <Row label="ОФД наличные после контрольной точки" value={formatKopeks(b.cashOooOfdSinceOpening)} />
        <Row label="ОФД наличные за месяц" value={formatKopeks(b.cashOooOfdMonth)} muted />
        <Row label="Инкассации на проверке" value={formatKopeks(b.cashOooPendingCollections)} />
        <Row label="Подтверждённые инкассации" value={formatKopeks(b.cashOooApprovedCollections)} />
        <Row label="Изъятия ООО→ИП на проверке" value={formatKopeks(b.cashOooPendingWithdrawalsToIp)} />
      </dl>
    </div>
  );
}
function IpCard({ b }: { b: CashBalances }) {
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-4 shadow-sm">
      <div className="text-sm font-medium text-slate-500">Наличные ИП</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-slate-900">{formatKopeks(b.cashIpFactBalance)}</div>
      <div className="mt-1 text-xs text-slate-400">{b.cashIpOpeningSet ? "Фактический остаток сейчас" : "Расчётный остаток от 0 ₽"}</div>
      <OpeningWarning set={b.cashIpOpeningSet} />
      <dl className="mt-3 space-y-1 text-sm">
        <Row label={`Контрольный остаток${b.cashIpOpeningDate ? ` (${b.cashIpOpeningDate})` : ""}`} value={b.cashIpOpeningSet ? formatKopeks(b.cashIpOpening) : "не задан"} />
        <Row label="Приход ИП вчера (ОФД)" value={formatKopeks(b.cashIpOfdYesterday)} />
        <Row label="Приход ИП сегодня (ОФД)" value={formatKopeks(b.cashIpOfdToday)} />
        <Row label="ОФД наличные после контрольной точки" value={formatKopeks(b.cashIpOfdSinceOpening)} />
        <Row label="ОФД наличные за месяц" value={formatKopeks(b.cashIpOfdMonth)} muted />
        <Row label="Изъятия из ООО" value={formatKopeks(b.cashIpWithdrawalsFromOoo)} />
        <Row label="Приход «Иное»" value={formatKopeks(b.cashIpOtherIncome)} />
        <Row label="Передано регионалу (подтв.)" value={formatKopeks(b.cashIpRegionalTransfers)} />
        <Row label="Расходы ИП на проверке" value={formatKopeks(b.cashIpPendingExpenses)} />
        <Row label="Подтверждённые расходы ИП" value={formatKopeks(b.cashIpApprovedExpenses)} />
      </dl>
    </div>
  );
}
function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return <div className="flex items-baseline justify-between gap-2"><dt className="text-slate-500">{label}</dt><dd className={muted ? "font-medium text-slate-400" : "font-medium text-slate-800"}>{value}</dd></div>;
}
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <div className="mb-5"><h2 className="mb-0.5 text-sm font-semibold text-slate-700">{title}</h2>{subtitle ? <p className="mb-2 text-xs text-slate-400">{subtitle}</p> : null}<div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">{children}</div></div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 align-top text-slate-700">{children}</td>;
}
