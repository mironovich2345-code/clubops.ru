import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentCompanyAndClub, getCurrentAccessContext, managerOwnFilter } from "@/lib/access";
import { getRefundsForScope, type RefundWithClub } from "@/lib/refunds";
import { APPROVAL_STATUS_LABELS } from "@/lib/approval";
import { REFUND_V2_STATUS_LABELS } from "@/lib/refund-workflow";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const statusLabel = (r: RefundWithClub) =>
  (r.entryVersion === 2 ? REFUND_V2_STATUS_LABELS[r.status] : APPROVAL_STATUS_LABELS[r.status]) ?? r.status;

export default async function RefundsPage() {
  const user = await requirePageAccess("refunds");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) return <NoCompanyState title="Возвраты" description="Загрузка и согласование возвратов" />;

  // Manager-only actors get an own-only query (no all-club refunds ever fetched);
  // elevated viewers get the whole scope. The in-memory `mine`/`visible` split
  // below stays correct because a manager's result set is already own-only.
  const preCtx = await getCurrentAccessContext();
  const refunds = await getRefundsForScope(scope, preCtx ? managerOwnFilter(preCtx).createdByUserId : undefined);
  const ctx = preCtx;
  const roles = ctx?.effectiveRoles ?? [];
  const isManager = roles.includes("manager");
  const isRegional = roles.includes("regional_director");
  const isAccounting = roles.some((r) => r === "accountant" || r === "chief_accountant");
  const isElevatedViewer = isRegional || isAccounting || roles.some((r) => r === "owner" || r === "general_director");
  const myId = ctx?.user.id;

  // Manager sees only their OWN refunds; elevated viewers see the whole scope.
  const mine = refunds.filter((r) => r.createdByUserId === myId);
  const visible = isElevatedViewer ? refunds : mine;

  const regionalQueue = isRegional ? refunds.filter((r) => r.entryVersion === 2 && r.status === "pending_regional_review") : [];
  const accountingQueue = isAccounting ? refunds.filter((r) => r.entryVersion === 2 && r.status === "accounting_in_progress") : [];
  const managerCorrections = isManager ? mine.filter((r) => r.entryVersion === 2 && r.status === "needs_correction") : [];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Возвраты" description="Согласование и учёт возвратов" />
        {isManager ? (
          <Link href="/refunds/new" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
            + Новый возврат
          </Link>
        ) : null}
      </div>

      {managerCorrections.length > 0 ? <Queue title="Требуют исправления" rows={managerCorrections} tone="amber" /> : null}
      {regionalQueue.length > 0 ? <Queue title="Ожидают моей проверки" rows={regionalQueue} tone="sky" /> : null}
      {accountingQueue.length > 0 ? <Queue title="В работе у бухгалтерии" rows={accountingQueue} tone="emerald" /> : null}

      <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Все возвраты</div>
        <RefundTable rows={visible} empty="Пока нет возвратов." />
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  sky: "border-sky-200 bg-sky-50 text-sky-900",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
};

function Queue({ title, rows, tone }: { title: string; rows: RefundWithClub[]; tone: string }) {
  return (
    <div className={`mt-4 overflow-hidden rounded-lg border shadow-sm ${TONE[tone] ?? "border-slate-200 bg-white"}`}>
      <div className="px-4 py-2 text-sm font-semibold">{title} · {rows.length}</div>
      <div className="bg-white">
        <RefundTable rows={rows} empty="—" />
      </div>
    </div>
  );
}

function RefundTable({ rows, empty }: { rows: RefundWithClub[]; empty: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr><Th>Клиент</Th><Th className="text-right">Сумма</Th><Th>Статус</Th><Th>Клуб</Th><Th>Создан</Th><Th>Действия</Th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">{empty}</td></tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td><div className="font-medium text-slate-900">{r.clientName ?? "— без клиента —"}</div></Td>
                <Td className="whitespace-nowrap text-right font-medium text-slate-900">{formatKopeks(r.amountKopeks)}</Td>
                <Td className="whitespace-nowrap">{statusLabel(r)}</Td>
                <Td className="whitespace-nowrap text-slate-600">{r.club.name}</Td>
                <Td className="whitespace-nowrap text-slate-500">{dateFormatter.format(r.createdAt)}</Td>
                <Td><Link href={`/refunds/${r.id}`} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">Открыть</Link></Td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
