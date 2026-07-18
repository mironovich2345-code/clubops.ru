import { redirect } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { loadClubCashBalances } from "@/lib/cash-collections";

export const dynamic = "force-dynamic";

// The legacy confirmed-only "Касса ИП" (CashWallet/CashMovement) is retired from the
// user flow: it showed a SECOND, different ИП balance that conflicted with the fact
// balance. Cash management now lives in Финансы → Инкассация (/collections), which is
// the single source of truth via loadClubCashBalances. This page is now a read-only
// pointer showing the same fact balance. The wallet ledger + its actions remain in
// code (cash-actions.ts / cash-wallets.ts) but are no longer surfaced here.
export default async function CashPage() {
  await requirePageAccess("expenses");
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/expenses");
  const companyId = ctx.selectedCompanyId;
  const clubId = ctx.selectedClubId ?? (ctx.allowedClubIds.length === 1 ? ctx.allowedClubIds[0] : null);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Касса ИП" description="Фактический остаток наличных ИП" />
      <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Управление кассой перенесено в Финансы → Инкассация. Контрольные остатки, инкассации и изъятия — на одной странице.
        <Link href="/collections" className="ml-1 font-medium text-brand-700 underline">Перейти в «Инкассация»</Link>
      </div>
      {clubId ? <IpBlock companyId={companyId} clubId={clubId} /> : <div className="mt-4 text-sm text-slate-500">Выберите клуб, чтобы увидеть остаток.</div>}
    </div>
  );
}

async function IpBlock({ companyId, clubId }: { companyId: string; clubId: string }) {
  const { balances: b, ipName } = await loadClubCashBalances(companyId, clubId);
  return (
    <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">Наличные ИП{ipName ? ` — ${ipName}` : ""}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{formatKopeks(b.cashIpFactBalance)}</div>
      <div className="text-xs text-slate-500">{b.cashIpOpeningSet ? "Фактический остаток ИП сейчас" : "Расчётный остаток ИП от 0 ₽"}</div>
      {!b.cashIpOpeningSet ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Начальный остаток не задан. Задайте контрольный остаток в Финансы → Инкассация.</div>
      ) : null}
      <dl className="mt-3 space-y-1 text-sm">
        <Row label={`Контрольный остаток${b.cashIpOpeningDate ? ` (${b.cashIpOpeningDate})` : ""}`} value={b.cashIpOpeningSet ? formatKopeks(b.cashIpOpening) : "не задан"} />
        <Row label="Приход ИП вчера (ОФД)" value={formatKopeks(b.cashIpOfdYesterday)} />
        <Row label="Изъятия из ООО" value={formatKopeks(b.cashIpWithdrawalsFromOoo)} />
        <Row label="Приход «Иное»" value={formatKopeks(b.cashIpOtherIncome)} />
        <Row label="Расходы ИП на проверке" value={formatKopeks(b.cashIpPendingExpenses)} />
      </dl>
      <Link href="/collections" className="mt-3 inline-block text-xs font-medium text-brand-700 hover:underline">Управление контрольными остатками, изъятиями и инкассацией →</Link>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between gap-2"><dt className="text-slate-500">{label}</dt><dd className="font-medium text-slate-800">{value}</dd></div>;
}
