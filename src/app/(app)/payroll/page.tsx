import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { canManagePaySchemes } from "@/lib/payroll/access";
import { formatKopeks } from "@/lib/money";
import { loadPayrollOverview } from "@/lib/payroll/overview";
import { PayrollNav } from "./_components/PayrollNav";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";

function monthOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Зарплата (ФОТ)" description="Схемы оплаты, начисления и выплаты сотрудникам" />;
  }
  const companyId = ctx.selectedCompanyId;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const now = new Date();
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : monthOf(now);
  const ov = await loadPayrollOverview(companyId, clubIds, month, now);
  const monthTitle = new Date(`${month}-01T00:00:00`).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });

  // «Требуют внимания» — direct links to the right screen. (Расширяется отдельно.)
  const attention: Array<{ text: string; href: string; tone: "warn" | "info" }> = [];
  if (ov.employeesNotConfigured > 0) attention.push({ text: `Сотрудников без схемы оплаты: ${ov.employeesNotConfigured}. Настройте схему перед расчётом.`, href: "/payroll/employees", tone: "warn" });
  if (ov.periodsNeedsDecision > 0) attention.push({ text: `Периодов возвращено на исправление: ${ov.periodsNeedsDecision}.`, href: "/payroll/periods?status=needs_correction", tone: "warn" });
  if (ov.periodsOnReview > 0) attention.push({ text: `Периодов на согласовании: ${ov.periodsOnReview}.`, href: "/payroll/periods?status=review", tone: "info" });
  if (ov.remainingKopeks > 0) attention.push({ text: `Остаток к выплате за ${monthTitle}: ${formatKopeks(ov.remainingKopeks)}.`, href: "/payroll/payments", tone: "info" });
  if (ov.activeDebtsCount > 0) attention.push({ text: `Активных долгов: ${ov.activeDebtsCount} на ${formatKopeks(ov.activeDebtsKopeks)}.`, href: "/payroll/obligations", tone: "info" });

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Зарплата (ФОТ)" description="Обзор: настройка, начисления, авансы и выплаты по клубам." />
      <PayrollNav />

      {/* Month picker */}
      <form method="get" className="mb-4 flex items-center gap-2">
        <label className="text-sm text-slate-500 dark:text-slate-400">Месяц</label>
        <input type="month" name="month" defaultValue={month} className="input py-1 text-sm" />
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Показать</button>
      </form>

      {/* KPI cards */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Сотрудников с активной схемой" value={String(ov.employeesWithScheme)} sub={`из ${ov.employeesActive}`} href="/payroll/employees" />
        <Kpi label="Не настроено" value={String(ov.employeesNotConfigured)} accent={ov.employeesNotConfigured > 0} href="/payroll/employees" />
        <Kpi label="Периодов в черновике" value={String(ov.periodsDraft)} href="/payroll/periods" />
        <Kpi label="На согласовании" value={String(ov.periodsOnReview)} href="/payroll/periods" />
        <Kpi label="Требуют решения" value={String(ov.periodsNeedsDecision)} accent={ov.periodsNeedsDecision > 0} href="/payroll/periods" />
        <Kpi label={`Начислено · ${monthTitle}`} value={formatKopeks(ov.accruedKopeks)} href="/payroll/periods" />
        <Kpi label="Выплачено" value={formatKopeks(ov.paidKopeks)} href="/payroll/payments" />
        <Kpi label="Остаток к выплате" value={formatKopeks(ov.remainingKopeks)} accent={ov.remainingKopeks > 0} href="/payroll/payments" />
        <Kpi label="Активные долги" value={formatKopeks(ov.activeDebtsKopeks)} sub={`${ov.activeDebtsCount} шт.`} href="/payroll/obligations" />
        <Kpi label={`Авансы · ${monthTitle}`} value={formatKopeks(ov.advancesKopeks)} sub={`${ov.advancesCount} шт.`} href="/payroll/advances" />
      </div>

      {/* Требуют внимания */}
      <div className={`mb-6 p-5 ${CARD}`}>
        <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Требуют внимания</div>
        {attention.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Нет нерешённых вопросов за выбранный месяц.</p>
        ) : (
          <ul className="space-y-2">
            {attention.map((a, i) => (
              <li key={i}>
                <Link href={a.href} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/40 ${a.tone === "warn" ? "border-amber-200 bg-amber-50/50 dark:border-amber-900/50" : "border-slate-200 dark:border-slate-800"}`}>
                  <span className="text-slate-700 dark:text-slate-200">{a.text}</span>
                  <span className="ml-3 shrink-0 text-brand-600 dark:text-brand-400">Открыть →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!canManagePaySchemes(ctx.effectiveRoles) ? (
        <div className={`p-4 text-sm text-slate-500 dark:text-slate-400 ${CARD}`}>
          Схемы оплаты настраивают региональный директор, главный бухгалтер или собственник. Вам доступны просмотр, авансы и оформление выплат по правам.
        </div>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, sub, accent, href }: { label: string; value: string; sub?: string; accent?: boolean; href: string }) {
  return (
    <Link href={href} className={`flex flex-col justify-between p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40 ${CARD}`}>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${accent ? "text-amber-600 dark:text-amber-400" : "text-slate-900 dark:text-slate-100"}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div> : null}
    </Link>
  );
}
