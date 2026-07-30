import { redirect } from "next/navigation";
import { CompactPageHeader, MobileDataCard } from "@/components/mobile/density";
import { AccordionGroup, AccordionItem } from "./_components/SingleAccordion";
import { formatKopeks } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational, type Role } from "@/lib/auth";
import { legalEntityTypeLabel } from "@/lib/legal-entities";
import { loadClubCashBalances, loadCashOpsHistory } from "@/lib/cash-collections";
import { getEligibleRegionalDirectorsForClub, getRegionalTransfersForClub, getSnapshotTimeline } from "@/lib/cash-transfers";
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
import { CashSyncButtons, CollectionForm, WithdrawalForm, OtherIncomeForm, ReviewButtons, CancelButton, OpeningBalanceForm } from "./_components/CollectionForms";
import { RegionalTransferForm, TransferConfirmButton, TransferCancelButton, SnapshotCorrectionButton } from "./_components/CashTransferForms";
import { ReconciliationForm, type ReconEntity } from "./_components/ReconciliationForm";
import { ReconciliationReview } from "./_components/ReconciliationReview";

export const dynamic = "force-dynamic";

const dfmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const STATUS_LABELS: Record<string, string> = {
  pending_accountant_review: "На проверке",
  pending_review: "На проверке",
  pending_confirmation: "Ожидает подтверждения управляющего",
  approved: "Подтверждено",
  confirmed: "Подтверждено",
  rejected: "Отклонено",
  cancelled: "Отменено",
  draft: "Черновик",
};

function canReview(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "accountant" || r === "chief_accountant" || r === "owner" || r === "general_director" || r === "regional_director");
}

export default async function CollectionsPage() {
  await requirePageAccess("collections");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/dashboard");
  const companyId = ctx.selectedCompanyId;
  const clubIds = ctx.allowedClubIds;
  const roles = ctx.effectiveRoles;
  const mayCreate = canCreateOperational(roles);
  const mayReview = canReview(roles);
  const myUserId = ctx.user.id;
  const today = ymd(new Date());
  const CANCELABLE: Record<string, string[]> = { collection: ["draft", "pending_accountant_review"], withdrawal: ["draft", "pending_review"], other_income: ["draft", "pending_review"] };
  const SOURCE_LABELS: Record<string, string> = { regional: "Региональный директор", owner: "Собственник", general_director: "Генеральный директор", other: "Другое" };
  const OP_TYPE: Record<string, string> = { collection: "Инкассация ООО", withdrawal: "Изъятие ООО→ИП", other_income: "Приход «Иное»" };

  const clubs = clubIds.length ? await prisma.club.findMany({ where: { companyId, id: { in: clubIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const now = new Date();
  const [perClub, history, reconTargets, reconHistory, directorsPairs, transfers] = await Promise.all([
    Promise.all(clubs.map(async (c) => ({ club: c, res: await loadClubCashBalances(companyId, c.id) }))),
    loadCashOpsHistory(companyId, clubIds, 50),
    canSubmitReconciliation(roles) && clubs.length
      ? Promise.all(clubs.map(async (c) => ({ club: c, ...(await buildReconciliationTargets(companyId, c.id, now)) })))
      : Promise.resolve([]),
    getReconciliationsForScope(companyId, clubIds, { limit: 40 }),
    clubs.length ? Promise.all(clubs.map(async (c) => [c.id, await getEligibleRegionalDirectorsForClub(companyId, c.id)] as const)) : Promise.resolve([]),
    clubs.length ? Promise.all(clubs.map((c) => getRegionalTransfersForClub(c.id, 30))).then((r) => r.flat()) : Promise.resolve([]),
  ]);
  const directorsByClub: Record<string, { id: string; name: string }[]> = Object.fromEntries(directorsPairs);
  // Version timelines of control points, per club + legal entity (active + superseded).
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

  // Author names for the history tables (SAFE: display name only, no personal data).
  const authorIds = [...new Set([...history.map((h) => h.createdByUserId), ...timelines.flatMap((t) => t.rows.map((r) => r.createdById)), ...transfers.flatMap((t) => [t.createdById, t.confirmedById].filter((x): x is string => Boolean(x))), ...reconHistory.map((r) => r.submittedById).filter((x): x is string => Boolean(x))])];
  const authors = authorIds.length ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } }) : [];
  const authorName = new Map(authors.map((a) => [a.id, a.name]));
  // Clubs where the current user is an EXPLICIT manager → may confirm a transfer receipt.
  const myManagerClubIds = new Set(
    clubIds.length ? (await prisma.clubUserAccess.findMany({ where: { userId: myUserId, role: "manager", clubId: { in: clubIds } }, select: { clubId: true } })).map((r) => r.clubId) : [],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <CompactPageHeader title="Инкассация" subtitle="Наличные ООО и ИП, инкассация и изъятия. Остаток считается по фактическому движению денег." />

      {/* Always visible: sync + per-club ООО/ИП cards. Everything else is collapsed. */}
      <Section title="Синхронизация наличных из ОФД">
        <CashSyncButtons />
        <p className="mt-3 text-xs text-slate-500">Обновляет ОФД-данные по наличным. После синхронизации пересчитываются вчера, период и фактический остаток.</p>
      </Section>

      {perClub.length === 0 ? (
        <div className="mb-8 rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500 shadow-sm">Нет доступных клубов.</div>
      ) : (
        perClub.map(({ club, res }) => (
          <Section key={club.id} title={`Клуб: ${club.name}`}>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <OooCard b={res.balances} />
              <IpCard b={res.balances} />
            </div>
          </Section>
        ))
      )}

      <AccordionGroup>
      <AccordionItem id="control" title="Контрольный остаток" subtitle="Задать фактическую сумму наличных на дату (можно раньше существующих)">
        <p className="mb-3 text-xs text-slate-500">Текущий остаток считается от последней применимой контрольной точки (effectiveDate ≤ сегодня) плюс движения после неё. Можно добавить более раннюю точку — она изменит только исторический расчёт до следующей точки и не изменит сегодняшний остаток. Записи append-only: сумма правится только через «Скорректировать» (создаётся новая версия).</p>
        <OpeningBalanceForm clubs={clubs} today={today} />
        {timelines.length > 0 ? (
          <div className="mt-5 space-y-5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Хронология контрольных точек</div>
            {timelines.map((t) => (
              <div key={`${t.clubId}-${t.entityType}`}>
                <div className="mb-2 text-xs font-medium text-slate-600">{t.clubName} · {legalEntityTypeLabel(t.entityType)}</div>
                {/* Desktop timeline table (≥lg) */}
                <div className="hidden overflow-x-auto rounded-lg border border-slate-200 lg:block">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50"><tr><Th>Дата (effective)</Th><Th>Сумма</Th><Th>Период действия</Th><Th>Версия</Th><Th>Статус</Th><Th>Создано</Th><Th>Автор</Th><Th>Комментарий</Th><Th>Действия</Th></tr></thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {t.rows.map((r) => (
                        <tr key={r.id} className={r.status === "superseded" ? "text-slate-400" : undefined}>
                          <Td>{dfmt.format(r.snapshotDate)}</Td>
                          <Td>{formatKopeks(r.actualBalanceKopeks)}</Td>
                          <Td>{r.status === "active" ? `с ${r.effectiveFrom}${r.effectiveTo ? ` до ${r.effectiveTo}` : " по настоящее время"}` : "—"}</Td>
                          <Td>v{r.version}</Td>
                          <Td>{r.status === "active" ? "активна" : "скорректирована"}{r.supersedesSnapshotId ? " (коррекция)" : ""}</Td>
                          <Td>{dfmt.format(r.createdAt)}</Td>
                          <Td>{authorName.get(r.createdById) ?? "—"}</Td>
                          <Td>{r.correctionReason ?? r.comment ?? "—"}</Td>
                          <Td>{mayCreate && r.status === "active" ? <SnapshotCorrectionButton snapshotId={r.id} /> : "—"}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Mobile cards — no clipped table */}
                <div className="space-y-3 lg:hidden">
                  {t.rows.map((r) => (
                    <MobileDataCard
                      key={r.id}
                      title={`${dfmt.format(r.snapshotDate)} · v${r.version}`}
                      badge={<span className="text-xs font-medium text-[var(--text-muted)]">{r.status === "active" ? "активна" : "скорректирована"}</span>}
                      rows={[
                        { label: "Сумма", value: formatKopeks(r.actualBalanceKopeks), strong: true },
                        { label: "Период", value: r.status === "active" ? `с ${r.effectiveFrom}${r.effectiveTo ? ` до ${r.effectiveTo}` : " — н.в."}` : "—" },
                        { label: "Автор", value: authorName.get(r.createdById) ?? "—" },
                        ...(r.correctionReason || r.comment ? [{ label: "Комментарий", value: r.correctionReason ?? r.comment ?? "" }] : []),
                      ]}
                      footer={mayCreate && r.status === "active" ? <SnapshotCorrectionButton snapshotId={r.id} /> : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </AccordionItem>

      <AccordionItem id="recon" title="Фактические деньги (сверка наличных)" subtitle="Ежедневное подтверждение пересчитанных наличных до 12:00 следующего дня">
        {canSubmitReconciliation(roles) && reconTargets.length > 0 ? (
          <div className="mb-5 space-y-5">
            {reconTargets.map(({ club, businessDate, entities }) => {
              const reconEntities: ReconEntity[] = entities.map((e) => ({
                legalEntityType: e.legalEntityType,
                name: e.name,
                ofdCashRevenueKopeks: e.ofdCashRevenueKopeks,
                expectedCashBalanceKopeks: e.expectedCashBalanceKopeks,
                actualKopeks: e.existing ? e.existing.actualCashBalanceKopeks : null,
                status: e.existing?.status ?? null,
              }));
              return (
                <div key={club.id}>
                  {clubs.length > 1 ? <div className="mb-2 text-xs font-semibold text-slate-600">Клуб: {club.name}</div> : null}
                  <ReconciliationForm clubId={club.id} businessDateLabel={dfmt.format(businessDate)} entities={reconEntities} />
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">История сверок</div>
        {reconHistory.length === 0 ? (
          <div className="mt-2 text-sm text-slate-500">Сверок пока нет.</div>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr><Th>Дата</Th><Th>Клуб</Th><Th>Юрлицо</Th><Th>Ожидалось</Th><Th>Факт</Th><Th>Расхожд.</Th><Th>Статус</Th><Th>Кто</Th><Th>Действия</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {reconHistory.map((r) => {
                  const overdue = isReconciliationOverdue(r.status, r.businessDate, now);
                  const needsRegional = r.differenceKopeks !== 0 && !r.regionalReviewedById && r.status !== "closed";
                  const needsAccounting = r.status !== "closed" && (r.differenceKopeks === 0 || Boolean(r.regionalReviewedById));
                  return (
                    <tr key={r.id} className={overdue ? "bg-amber-50" : r.differenceKopeks !== 0 && r.status !== "closed" ? "bg-rose-50/40" : undefined}>
                      <Td>{dfmt.format(r.businessDate)}</Td>
                      <Td>{clubName.get(r.clubId) ?? "—"}</Td>
                      <Td>{r.legalEntityType.toUpperCase()}</Td>
                      <Td>{formatKopeks(r.expectedCashBalanceKopeks)}</Td>
                      <Td>{formatKopeks(r.actualCashBalanceKopeks)}</Td>
                      <Td><span className={r.differenceKopeks !== 0 ? "font-semibold text-rose-600" : "text-emerald-600"}>{formatKopeks(r.differenceKopeks)}</span></Td>
                      <Td>{displayReconStatus(r, now)}</Td>
                      <Td>{authorName.get(r.submittedById ?? "") ?? "—"}</Td>
                      <Td>
                        {(mayRegionalRecon || mayAccountingRecon) && r.status !== "closed" && r.status !== "awaiting_input" ? (
                          <ReconciliationReview
                            reconciliationId={r.id}
                            canRegional={mayRegionalRecon}
                            canAccounting={mayAccountingRecon}
                            needsRegional={needsRegional}
                            needsAccounting={needsAccounting}
                          />
                        ) : "—"}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AccordionItem>

      {mayCreate ? (
        <>
          <AccordionItem id="collect" title="Инкассировать ООО" subtitle="Сдать наличные ООО. Уменьшает остаток ООО"><CollectionForm clubs={clubs} today={today} /></AccordionItem>
          <AccordionItem id="withdraw" title="Изъять из ООО в ИП" subtitle="Перенос наличных из ООО в ИП. Не продажа и не доход"><WithdrawalForm clubs={clubs} today={today} /></AccordionItem>
          <AccordionItem id="other" title="Пополнить ИП — приход «Иное»" subtitle="Внесение наличных от регионала, собственника или директора. Не продажа (это и есть возврат денег от регионала)"><OtherIncomeForm clubs={clubs} today={today} /></AccordionItem>
          <AccordionItem id="transfer" title="Передать деньги региональному директору" subtitle="Наличные ИП физически переданы регионалу. Не расход и не доход — движение денег">
            <p className="mb-3 text-xs text-slate-500">Уменьшает фактический остаток ИП только ПОСЛЕ подтверждения управляющим клуба. Возврат денег от регионала оформляется как «Приход Иное» с источником «Региональный директор».</p>
            <RegionalTransferForm clubs={clubs} directorsByClub={directorsByClub} today={today} />
          </AccordionItem>
        </>
      ) : null}

      <AccordionItem id="transfer-history" title="Передачи региональному директору" subtitle="История передач наличных ИП регионалу и подтверждения">
        {transfers.length === 0 ? (
          <div className="text-sm text-slate-500">Передач пока нет.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr><Th>Дата</Th><Th>Клуб</Th><Th>Сумма</Th><Th>Получатель</Th><Th>Статус</Th><Th>Автор</Th><Th>Подтвердил</Th><Th>Комментарий</Th><Th>Действия</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {transfers.map((t) => {
                  const canConfirm = t.status === "pending_confirmation" && myManagerClubIds.has(t.clubId);
                  const canCancelT = t.status === "pending_confirmation" && (t.createdById === myUserId || myManagerClubIds.has(t.clubId));
                  return (
                    <tr key={t.id}>
                      <Td>{dfmt.format(t.operationDate)}</Td>
                      <Td>{clubName.get(t.clubId) ?? "—"}</Td>
                      <Td><span className="font-medium text-rose-600">−{formatKopeks(t.amountKopeks)}</span></Td>
                      <Td>{t.recipientNameSnapshot}</Td>
                      <Td>{STATUS_LABELS[t.status] ?? t.status}</Td>
                      <Td>{authorName.get(t.createdById) ?? "—"}</Td>
                      <Td>{t.confirmedById ? authorName.get(t.confirmedById) ?? "—" : "—"}</Td>
                      <Td>{t.cancellationReason ? `Отменено: ${t.cancellationReason}` : t.comment ?? "—"}</Td>
                      <Td>
                        <div className="flex flex-wrap items-start gap-2">
                          {canConfirm ? <TransferConfirmButton id={t.id} /> : null}
                          {canCancelT ? <TransferCancelButton id={t.id} /> : null}
                          {!canConfirm && !canCancelT ? "—" : null}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AccordionItem>

      <AccordionItem id="history" title="История операций" subtitle="Инкассации, изъятия и приходы «Иное»">
        {history.length === 0 ? (
          <div className="text-sm text-slate-500">Операций пока нет.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr><Th>Дата</Th><Th>Тип</Th><Th>Клуб</Th><Th>Сумма</Th><Th>Статус</Th><Th>Комментарий</Th><Th>Док.</Th><Th>Кто создал</Th><Th>Действия</Th></tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {history.map((h) => {
                  const isPending = h.status === "pending_accountant_review" || h.status === "pending_review";
                  const canCancel = CANCELABLE[h.kind].includes(h.status) && (h.createdByUserId === myUserId || mayReview);
                  return (
                    <tr key={h.id}>
                      <Td>{dfmt.format(h.operationDate)}</Td>
                      <Td>{OP_TYPE[h.kind] ?? h.kind}{h.kind === "other_income" && h.source ? ` · ${SOURCE_LABELS[h.source] ?? h.source}` : ""}</Td>
                      <Td>{clubName.get(h.clubId) ?? "—"}</Td>
                      <Td>{formatKopeks(h.amountKopeks)}</Td>
                      <Td>{STATUS_LABELS[h.status] ?? h.status}</Td>
                      <Td>{h.comment ?? "—"}</Td>
                      <Td>{h.documents}</Td>
                      <Td>{authorName.get(h.createdByUserId) ?? "—"}</Td>
                      <Td>
                        <div className="flex flex-wrap items-start gap-2">
                          {mayReview && isPending ? <ReviewButtons id={h.id} kind={h.kind} /> : null}
                          {canCancel ? <CancelButton id={h.id} kind={h.kind} /> : null}
                          {!canCancel && !(mayReview && isPending) ? "—" : null}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AccordionItem>
      </AccordionGroup>
    </div>
  );
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
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="mb-5"><h2 className="mb-2 text-sm font-semibold text-slate-700">{title}</h2><div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">{children}</div></div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 align-top text-slate-700">{children}</td>;
}
