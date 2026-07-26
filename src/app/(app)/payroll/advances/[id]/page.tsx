import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { advancePaidKopeks, advanceApprovedKopeks, advanceRemainingKopeks, deriveAdvanceUiStatus } from "@/lib/payroll/advance-tranche-calc";
import { PAYROLL_POSITION_LABELS } from "@/lib/payroll/enums";
import { PayrollNav } from "../../_components/PayrollNav";
import { AddTrancheForm, ReverseTrancheButton, IncreaseApprovedForm } from "../../_components/AdvanceTrancheForms";

export const dynamic = "force-dynamic";
const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

export default async function AdvanceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Аванс" description="Транши аванса" />;
  const companyId = ctx.selectedCompanyId;
  const { id } = await params;
  const clubIds = (await getUserClubs(user.id, companyId)).map((c) => c.id);

  const adv = await prisma.payrollAdvance.findFirst({ where: { id, companyId } });
  if (!adv || !clubIds.includes(adv.clubId)) notFound();
  const [emp, club, tranches] = await Promise.all([
    prisma.clubEmployee.findUnique({ where: { id: adv.employeeId }, select: { fullName: true, position: true } }),
    prisma.club.findUnique({ where: { id: adv.clubId }, select: { name: true } }),
    prisma.payrollAdvancePayment.findMany({ where: { employeeAdvanceId: adv.id }, orderBy: { paidAt: "asc" } }),
  ]);
  const trLite = tranches.map((t) => ({ amountKopeks: t.amountKopeks, status: t.status }));
  const approved = advanceApprovedKopeks(adv);
  const paid = advancePaidKopeks(adv, trLite);
  const remaining = advanceRemainingKopeks(approved, paid);
  const hasReversed = tranches.some((t) => t.status === "reversed");
  const uiStatus = deriveAdvanceUiStatus(adv, paid, hasReversed);
  const legacySinglePayout = Boolean(adv.expenseId) && tranches.length === 0;

  const roles = ctx.effectiveRoles;
  const canCash = roles.some((r) => r === "manager" || r === "regional_director");
  const canBank = roles.some((r) => r === "accountant" || r === "chief_accountant");
  const canApprove = roles.some((r) => r === "regional_director" || r === "general_director" || r === "owner");
  const canReverse = canCash || canBank || roles.some((r) => r === "general_director" || r === "owner");

  return (
    <div className="mx-auto max-w-[820px]">
      <PageHeader title="Зарплата (ФОТ)" description="Аванс сотрудника" />
      <PayrollNav />
      <div className="mb-3"><Link href="/payroll/advances" className="text-sm text-slate-500 hover:text-slate-700">← Авансы</Link></div>

      {/* Header */}
      <div className={`mb-5 p-5 ${CARD}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">{emp?.fullName ?? adv.employeeId}</div>
            <div className="text-sm text-slate-500">{PAYROLL_POSITION_LABELS[emp?.position ?? ""] ?? "—"} · {club?.name ?? adv.clubId} · {String(adv.periodMonth).padStart(2, "0")}.{adv.periodYear}</div>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">{uiStatus}</span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <KV k="Заработано к дате" v={formatKopeks(adv.earnedToDateKopeks)} />
          <KV k="Согласовано" v={formatKopeks(approved)} />
          <KV k="Выплачено" v={formatKopeks(paid)} />
          <KV k="Остаток" v={formatKopeks(remaining)} accent={remaining > 0} />
        </dl>
        {adv.linkedPayrollCalculationId ? <p className="mt-2 text-xs text-slate-400">Связан с расчётом периода — учтён в остатке зарплаты.</p> : null}
        {adv.comment ? <p className="mt-1 text-xs text-slate-500">Комментарий: {adv.comment}</p> : null}
        <div className="mt-3"><IncreaseApprovedForm advanceId={adv.id} canApprove={canApprove} /></div>
      </div>

      {/* Tranches (cards — mobile-friendly) */}
      <div className="mb-5">
        <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Транши ({tranches.length})</div>
        {legacySinglePayout ? (
          <div className={`p-3 text-sm text-slate-600 ${CARD}`}>Этот аванс выплачен единым платежом (legacy). Для перехода на транши выполните backfill.</div>
        ) : tranches.length === 0 ? (
          <div className={`p-3 text-sm text-slate-500 ${CARD}`}>Выплат ещё нет.</div>
        ) : (
          <ul className="space-y-2">
            {tranches.map((t) => (
              <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 p-3 text-sm ${CARD} ${t.status === "reversed" ? "opacity-60" : ""}`}>
                <div>
                  <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">{formatKopeks(t.amountKopeks)}</span>
                  <span className="ml-2 text-xs text-slate-500">{t.paymentMethod === "bank" ? "безнал" : "наличные"} · {dateFmt.format(t.paidAt)}</span>
                  {t.status === "reversed" ? <span className="ml-2 text-xs text-rose-600">сторнирован{t.reversalReason ? `: ${t.reversalReason}` : ""}</span> : null}
                </div>
                {t.status === "paid" && canReverse ? <ReverseTrancheButton trancheId={t.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Add tranche */}
      {!legacySinglePayout && adv.status !== "canceled" && adv.status !== "rejected" && adv.status !== "requested" ? (
        <AddTrancheForm advanceId={adv.id} canCash={canCash} canBank={canBank} approvedKopeks={approved} paidKopeks={paid} />
      ) : null}
    </div>
  );
}

function KV({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return <div><dt className="text-xs text-slate-500 dark:text-slate-400">{k}</dt><dd className={`font-semibold tabular-nums ${accent ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{v}</dd></div>;
}
