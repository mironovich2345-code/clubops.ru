import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { notFound } from "next/navigation";
import { requirePageAccess, getCurrentAccessContext, getUserClubs, userHasCompanyRole } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { canManagePaySchemes, canViewRegionalPayroll } from "@/lib/payroll/access";
import { regionalTotals, paidByClub, REGIONAL_BASE_LABELS } from "@/lib/payroll/regional";
import { RegionalCreateForm, RegionalPaymentForm } from "../_components/RegionalCityForms";
import { PayrollNav } from "../_components/PayrollNav";
import { approveRegionalCityPayroll, cancelRegionalCityPayment } from "./actions";

export const dynamic = "force-dynamic";
const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

export default async function RegionalPayrollPage() {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Зарплата регионала" description="Единый расчёт по городу" />;
  // Regional payroll is money-sensitive and NOT a club manager's concern (§7/§16). Guard
  // VIEW server-side — a manager cannot read it even by typing the URL. notFound() (404)
  // rather than a redirect so the route does not even acknowledge the data exists.
  if (!canViewRegionalPayroll(ctx.effectiveRoles)) notFound();
  const companyId = ctx.selectedCompanyId;
  const clubs = await getUserClubs(user.id, companyId);
  const clubsByCity = new Map<string, Array<{ id: string; name: string }>>();
  const clubName = new Map<string, string>();
  for (const c of clubs) {
    clubName.set(c.id, c.name);
    const city = c.city ?? "";
    if (!city) continue;
    clubsByCity.set(city, [...(clubsByCity.get(city) ?? []), { id: c.id, name: c.name }]);
  }
  const cities = [...clubsByCity.keys()].sort();
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const canManage = canManagePaySchemes(ctx.effectiveRoles);
  const isOwner = await userHasCompanyRole(user.id, companyId, ["owner"]);

  const rows = cities.length
    ? await prisma.regionalCityPayroll.findMany({ where: { companyId, city: { in: cities } }, orderBy: [{ year: "desc" }, { month: "desc" }] })
    : [];
  const payments = rows.length
    ? await prisma.regionalCityPayment.findMany({ where: { regionalCityPayrollId: { in: rows.map((r) => r.id) }, status: "confirmed" }, orderBy: { paymentDate: "asc" } })
    : [];
  const payBy = new Map<string, typeof payments>();
  for (const p of payments) payBy.set(p.regionalCityPayrollId, [...(payBy.get(p.regionalCityPayrollId) ?? []), p]);

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Зарплата (ФОТ)" description="Регионал: единое начисление на город и месяц; выплаты частями из клубов города. Схему и процент утверждает собственник." />
      <PayrollNav mode="full" />

      {canManage && cities.length > 0 ? (
        <div className={`mb-6 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Начисление по городу</div>
          <RegionalCreateForm cities={cities} currentMonth={currentMonth} />
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className={`px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>Начислений по городам пока нет.</div>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => {
            const ps = payBy.get(r.id) ?? [];
            const totals = regionalTotals(r.accruedKopeks, ps);
            const byClub = paidByClub(ps.map((p) => ({ clubId: p.clubId, amountKopeks: p.amountKopeks })));
            return (
              <div key={r.id} className={`p-4 ${CARD}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{r.city} · {String(r.month).padStart(2, "0")}.{r.year} · {r.regionalName}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{REGIONAL_BASE_LABELS[r.baseType] ?? r.baseType} {formatKopeks(r.baseKopeks)} × {(r.percentBp / 100).toFixed(2)}% · {r.status === "approved" ? "утверждено" : "черновик"}</div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-semibold tabular-nums">Начислено {formatKopeks(r.accruedKopeks)}</div>
                    <div className="text-xs text-slate-500">Выплачено {formatKopeks(totals.paidKopeks)} · Остаток <span className={totals.remainingKopeks < 0 ? "text-rose-600" : ""}>{formatKopeks(totals.remainingKopeks)}</span>{totals.overpayKopeks > 0 ? <span className="text-rose-600"> · переплата {formatKopeks(totals.overpayKopeks)}</span> : null}</div>
                  </div>
                </div>

                {byClub.size > 0 ? (
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Выплачено по клубам: {[...byClub.entries()].map(([cid, amt]) => `${clubName.get(cid) ?? cid} ${formatKopeks(amt)}`).join(" · ")}
                  </div>
                ) : null}

                {ps.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {ps.map((p) => (
                      <li key={p.id} className="flex items-center justify-between text-xs">
                        <span className="text-slate-600 dark:text-slate-300">{clubName.get(p.clubId) ?? p.clubId} · {formatKopeks(p.amountKopeks)} · {p.paymentMethod === "bank" ? "безнал" : "наличные"}</span>
                        {canManage ? (
                          <form action={cancelRegionalCityPayment} onSubmit={(e) => { if (!confirm("Отменить выплату?")) e.preventDefault(); }}>
                            <input type="hidden" name="paymentId" value={p.id} />
                            <button type="submit" className="text-slate-400 hover:text-rose-600">✕</button>
                          </form>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {r.status === "draft" && isOwner ? (
                  <form action={approveRegionalCityPayroll} className="mt-3">
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">Утвердить (собственник)</button>
                  </form>
                ) : null}

                {r.status === "approved" && canManage ? (
                  <RegionalPaymentForm payrollId={r.id} clubs={clubsByCity.get(r.city) ?? []} />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
