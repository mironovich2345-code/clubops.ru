import Link from "next/link";
import { formatKopeks } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { loadClubCashBalances, loadPendingCashOps } from "@/lib/cash-collections";
import { IP_EXPENSE_PENDING_STATUSES } from "@/lib/cash-balances";

// Brief cash cards for the dashboard: ООО / ИП fact balances (physical cash), plus
// "на проверке" counters for reviewers. `showPending` gates the review counters —
// pass false for a plain manager (operational balances only, no owner analytics).
export async function CashScopeSummary({ companyId, clubIds, showPending }: { companyId: string; clubIds: string[]; showPending: boolean }) {
  if (clubIds.length === 0) return null;
  const [perClub, pending, ipPending] = await Promise.all([
    Promise.all(clubIds.map((id) => loadClubCashBalances(companyId, id))),
    showPending ? loadPendingCashOps(companyId, clubIds) : Promise.resolve([]),
    showPending
      ? prisma.expense.count({ where: { companyId, clubId: { in: clubIds }, entryVersion: 2, paymentMethod: "cash", status: { in: [...IP_EXPENSE_PENDING_STATUSES] } } })
      : Promise.resolve(0),
  ]);
  const oooFact = perClub.reduce((a, r) => a + r.balances.cashOooFactBalance, 0);
  const ipFact = perClub.reduce((a, r) => a + r.balances.cashIpFactBalance, 0);
  const collections = pending.filter((p) => p.kind === "collection").length;
  const withdrawals = pending.filter((p) => p.kind === "withdrawal").length;

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Наличные (фактический остаток)</h2>
        <Link href="/collections" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">Инкассация →</Link>
      </div>
      <div className={`grid grid-cols-2 gap-4 ${showPending ? "lg:grid-cols-5" : "lg:grid-cols-2"}`}>
        <Card label="Наличные ООО" value={formatKopeks(oooFact)} />
        <Card label="Наличные ИП" value={formatKopeks(ipFact)} />
        {showPending ? <Card label="Инкассации на проверке" value={String(collections)} muted={collections === 0} /> : null}
        {showPending ? <Card label="Изъятия на проверке" value={String(withdrawals)} muted={withdrawals === 0} /> : null}
        {showPending ? <Card label="Расходы ИП на проверке" value={String(ipPending)} muted={ipPending === 0} /> : null}
      </div>
    </div>
  );
}

function Card({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1.5 truncate text-xl font-semibold tracking-tight ${muted ? "text-slate-400 dark:text-slate-500" : "text-slate-900 dark:text-slate-100"}`}>{value}</div>
    </div>
  );
}
