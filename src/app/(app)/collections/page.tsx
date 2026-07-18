import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { formatKopeks } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canCreateOperational, type Role } from "@/lib/auth";
import { loadClubCashBalances } from "@/lib/cash-collections";
import type { CashBalances } from "@/lib/cash-balances";
import { CashSyncButtons, CollectionForm, WithdrawalForm, ReviewButtons } from "./_components/CollectionForms";

export const dynamic = "force-dynamic";

const dfmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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
  const today = ymd(new Date());

  const clubs = clubIds.length ? await prisma.club.findMany({ where: { companyId, id: { in: clubIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const perClub = await Promise.all(clubs.map(async (c) => ({ club: c, res: await loadClubCashBalances(companyId, c.id) })));

  // Pending operations for the review surface (SAFE fields only).
  const [pendingCollections, pendingWithdrawals] = clubIds.length
    ? await Promise.all([
        prisma.cashCollection.findMany({ where: { companyId, clubId: { in: clubIds }, status: "pending_accountant_review" }, orderBy: { operationDate: "desc" }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, comment: true } }),
        prisma.cashWithdrawal.findMany({ where: { companyId, clubId: { in: clubIds }, status: "pending_review" }, orderBy: { operationDate: "desc" }, select: { id: true, clubId: true, amountKopeks: true, operationDate: true, comment: true } }),
      ])
    : [[], []];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Инкассация" description="Наличные ООО и ИП, инкассация и изъятия. Остаток считается по фактическому движению денег." />

      <div className="mb-6 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        <div>Инкассация — сдача наличных ООО.</div>
        <div>Изъятие — перенос наличных из ООО в ИП. Это не продажа и не доход.</div>
        <div>Остаток считается по фактическому движению денег, поэтому операции на проверке уже учитываются.</div>
      </div>

      <Section title="Синхронизация наличных из ОФД">
        <CashSyncButtons />
        <p className="mt-3 text-xs text-slate-500">Подтягивает наличные продажи из ОФД за сегодня по подключённым кассам. Повторный запуск безопасен.</p>
      </Section>

      {perClub.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500 shadow-sm">Нет доступных клубов.</div>
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

      {mayCreate ? (
        <>
          <Section title="Инкассировать ООО"><CollectionForm clubs={clubs} today={today} /></Section>
          <Section title="Изъять из ООО в ИП"><WithdrawalForm clubs={clubs} today={today} /></Section>
        </>
      ) : null}

      <Section title="Операции на проверке">
        {pendingCollections.length === 0 && pendingWithdrawals.length === 0 ? (
          <div className="text-sm text-slate-500">Нет операций на проверке.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50"><tr><Th>Тип</Th><Th>Клуб</Th><Th>Сумма</Th><Th>Дата</Th><Th>Комментарий</Th>{mayReview ? <Th>Действия</Th> : null}</tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {pendingCollections.map((c) => (
                  <tr key={c.id}>
                    <Td>Инкассация ООО</Td><Td>{clubName.get(c.clubId) ?? "—"}</Td><Td>{formatKopeks(c.amountKopeks)}</Td><Td>{dfmt.format(c.operationDate)}</Td><Td>{c.comment ?? "—"}</Td>
                    {mayReview ? <Td><ReviewButtons id={c.id} kind="collection" /></Td> : null}
                  </tr>
                ))}
                {pendingWithdrawals.map((w) => (
                  <tr key={w.id}>
                    <Td>Изъятие ООО→ИП</Td><Td>{clubName.get(w.clubId) ?? "—"}</Td><Td>{formatKopeks(w.amountKopeks)}</Td><Td>{dfmt.format(w.operationDate)}</Td><Td>{w.comment ?? "—"}</Td>
                    {mayReview ? <Td><ReviewButtons id={w.id} kind="withdrawal" /></Td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function OooCard({ b }: { b: CashBalances }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">Наличные ООО</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{formatKopeks(b.cashOooFactBalance)}</div>
      <div className="mt-1 text-xs text-slate-400">Фактический остаток сейчас</div>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Начальный остаток" value={formatKopeks(b.cashOooOpening)} />
        <Row label="Приход ОФД ООО вчера" value={formatKopeks(b.cashOooOfdYesterday)} />
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
      <div className="mt-1 text-xs text-slate-400">Фактический остаток сейчас</div>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Начальный остаток" value={formatKopeks(b.cashIpOpening)} />
        <Row label="Приход ИП вчера" value={formatKopeks(b.cashIpOfdYesterday)} />
        <Row label="Изъятия из ООО" value={formatKopeks(b.cashIpWithdrawalsFromOoo)} />
        <Row label="Расходы ИП на проверке" value={formatKopeks(b.cashIpPendingExpenses)} />
        <Row label="Подтверждённые расходы ИП" value={formatKopeks(b.cashIpApprovedExpenses)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between gap-2"><dt className="text-slate-500">{label}</dt><dd className="font-medium text-slate-800">{value}</dd></div>;
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
