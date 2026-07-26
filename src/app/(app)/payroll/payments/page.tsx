import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { PayrollNav } from "../_components/PayrollNav";

export const dynamic = "force-dynamic";

// Placeholder — the full Выплаты section is built in a following commit.
export default async function PayrollPaymentsPage() {
  await requirePageAccess("payroll");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return <NoCompanyState title="Выплаты" description="Выплаты зарплаты" />;
  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Зарплата (ФОТ)" description="Выплаты" />
      <PayrollNav />
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Раздел «Выплаты» в подготовке.
      </div>
    </div>
  );
}
