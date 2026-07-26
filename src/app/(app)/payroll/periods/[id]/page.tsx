import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext, getUserClubs } from "@/lib/access";
import { getPeriodForScope, periodLabel, periodStatusLabel } from "@/lib/payroll/periods";
import { payrollNavMode } from "@/lib/payroll/access";
import { PayrollNav } from "../../_components/PayrollNav";
import { PayrollWorkspace } from "../../_components/PayrollWorkspace";

export const dynamic = "force-dynamic";

export default async function PayrollPeriodPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ group?: string }> }) {
  const user = await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) {
    return <NoCompanyState title="Расчётный период" description="Начисления зарплаты" />;
  }
  const companyId = ctx.selectedCompanyId;
  const { id } = await params;
  const { group } = await searchParams;
  const clubs = (await getUserClubs(user.id, companyId)).map((c) => ({ id: c.id, name: c.name }));
  const clubIds = clubs.map((c) => c.id);
  const period = await getPeriodForScope(companyId, clubIds, id);
  if (!period) notFound();

  const navMode = payrollNavMode(ctx.effectiveRoles);
  const clubName = clubs.find((c) => c.id === period.clubId)?.name ?? period.clubId;

  return (
    <div className="mx-auto max-w-[1100px]">
      {/* Managers work from /payroll; other roles keep the periods-list breadcrumb. */}
      <div className="mb-4">
        <Link
          href={navMode === "manager" ? "/payroll" : "/payroll/periods"}
          className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          {navMode === "manager" ? "← Зарплата" : "← Расчётные периоды"}
        </Link>
      </div>
      <PageHeader title={`${clubName} · ${periodLabel(period)}`} description={`Статус: ${periodStatusLabel(period.status)}`} />
      <PayrollNav mode={navMode} />

      <PayrollWorkspace
        period={period}
        clubs={clubs}
        effectiveRoles={ctx.effectiveRoles}
        basePath={`/payroll/periods/${period.id}`}
        group={group}
      />
    </div>
  );
}
