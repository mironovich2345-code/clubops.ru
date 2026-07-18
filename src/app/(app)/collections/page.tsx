import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { formatKopeks } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational, type Role } from "@/lib/auth";
import { legalEntityTypeLabel } from "@/lib/legal-entities";
import { loadClubCashBalances, loadCashOpsHistory, loadClubOpeningHistory } from "@/lib/cash-collections";
import type { CashBalances } from "@/lib/cash-balances";
import { CashSyncButtons, CollectionForm, WithdrawalForm, OtherIncomeForm, ReviewButtons, CancelButton, OpeningBalanceForm } from "./_components/CollectionForms";

export const dynamic = "force-dynamic";

const dfmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const STATUS_LABELS: Record<string, string> = {
  pending_accountant_review: "На проверке",
  pending_review: "На проверке",
  approved: "Подтверждено",
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
  const [perClub, history, openingHistory] = await Promise.all([
    Promise.all(clubs.map(async (c) => ({ club: c, res: await loadClubCashBalances(companyId, c.id) }))),
    loadCashOpsHistory(companyId, clubIds, 50),
    clubs.length ? Promise.all(clubs.map((c) => loadClubOpeningHistory(c.id, 10))).then((r) => r.flat()) : Promise.resolve([]),
  ]);

  // Author names for the history tables (SAFE: display name only, no personal data).
  const authorIds = [...new Set([...history.map((h) => h.createdByUserId), ...openingHistory.map((o) => o.createdById)])];
  const authors = authorIds.length ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } }) : [];
  const authorName = new Map(authors.map((a) => [a.id, a.name]));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Инкассация" description="Наличные ООО и ИП, инкассация и изъятия. Остаток считается по фактическому движению денег." />

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

      <Collapsible title="Контрольный остаток" subtitle="Задать фактическую сумму наличных на дату">
        <p className="mb-3 text-xs text-slate-500">Фактический остаток считается от последней контрольной точки плюс движения после неё. Прошлая запись не изменяется — создаётся новая контрольная точка.</p>
        <OpeningBalanceForm clubs={clubs} today={today} />
        {openingHistory.length > 0 ? (
          <div className="mt-5">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">История контрольных остатков</div>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50"><tr><Th>Дата</Th><Th>Юрлицо</Th><Th>Сумма</Th><Th>Комментарий</Th><Th>Кто задал</Th></tr></thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {openingHistory.map((o, i) => (
                    <tr key={i}>
                      <Td>{dfmt.format(o.snapshotDate)}</Td>
                      <Td>{o.entityType ? legalEntityTypeLabel(o.entityType) : "—"}</Td>
                      <Td>{formatKopeks(o.amountKopeks)}</Td>
                      <Td>{o.comment ?? "—"}</Td>
                      <Td>{authorName.get(o.createdById) ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Collapsible>

      {mayCreate ? (
        <>
          <Collapsible title="Инкассировать ООО" subtitle="Сдать наличные ООО. Уменьшает остаток ООО"><CollectionForm clubs={clubs} today={today} /></Collapsible>
          <Collapsible title="Изъять из ООО в ИП" subtitle="Перенос наличных из ООО в ИП. Не продажа и не доход"><WithdrawalForm clubs={clubs} today={today} /></Collapsible>
          <Collapsible title="Пополнить ИП — приход «Иное»" subtitle="Внесение наличных от регионала, собственника или директора. Не продажа"><OtherIncomeForm clubs={clubs} today={today} /></Collapsible>
        </>
      ) : null}

      <Collapsible title="История операций" subtitle="Инкассации, изъятия и приходы «Иное»">
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
      </Collapsible>
    </div>
  );
}

// Native <details> collapsible — works without client JS, keyboard-accessible, and
// safe for server-action forms inside. Themed centrally (globals .dark remaps the
// neutral classes), so it reads correctly in light and dark. Collapsed by default.
function Collapsible({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <details className="group mb-4 rounded-lg border border-slate-200 bg-white shadow-sm">
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

function OpeningWarning({ set }: { set: boolean }) {
  if (set) return null;
  return <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Начальный остаток не задан. Укажите контрольный остаток кассы, чтобы расчёт был точным. Ниже — расчётный остаток от 0 ₽.</div>;
}

function OooCard({ b }: { b: CashBalances }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">Наличные ООО</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{formatKopeks(b.cashOooFactBalance)}</div>
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
    <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">Наличные ИП</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{formatKopeks(b.cashIpFactBalance)}</div>
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
  return <div className="mb-8"><h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2><div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">{children}</div></div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 align-top text-slate-700">{children}</td>;
}
