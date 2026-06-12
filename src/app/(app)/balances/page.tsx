import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentCompanyAndClub, getCurrentAccessContext } from "@/lib/access";
import { canManageBalances } from "@/lib/auth";
import { legalEntityTypeLabel } from "@/lib/legal-entities";
import {
  getLatestBalancesForScope,
  getRecentSnapshots,
  getSnapshotTargetsForScope,
  type EntityBalance,
} from "@/lib/balance-snapshots";
import { BalanceForm } from "./_components/BalanceForm";

export const dynamic = "force-dynamic";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function updatedLabel(date: Date | null): string {
  if (!date) return "";
  const today = new Date();
  const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((t0.getTime() - d0.getTime()) / 86_400_000);
  if (diff === 0) return "Обновлено сегодня";
  if (diff === 1) return "Обновлено вчера";
  return `Обновлено ${dateFmt.format(date)}`;
}

export default async function BalancesPage() {
  const user = await requirePageAccess("balances");
  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Остатки денежных средств" description="Фактические остатки ООО / ИП" />;
  }
  const ctx = await getCurrentAccessContext();
  if (!ctx) {
    return <NoCompanyState title="Остатки денежных средств" description="Фактические остатки ООО / ИП" />;
  }
  const companyId = scope.company.id;
  const canManage = canManageBalances(ctx.effectiveRoles);

  const [balances, history, targets] = await Promise.all([
    getLatestBalancesForScope(companyId, scope.clubIds),
    getRecentSnapshots(companyId, scope.clubIds, 10),
    canManage ? getSnapshotTargetsForScope(companyId, scope.clubIds) : Promise.resolve([]),
  ]);

  const targetOptions = targets.map((t) => ({
    value: `${t.clubId}:${t.legalEntityId}`,
    label: `${t.clubName} · ${t.legalEntityName}${t.type ? ` (${legalEntityTypeLabel(t.type)})` : ""}`,
  }));

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Остатки денежных средств" description="Фактические остатки ООО / ИП" />

      {/* Block 1 — current balances */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <BalanceCard label="ООО" balance={balances.ooo} accent="text-slate-900 dark:text-slate-100" />
        <BalanceCard label="ИП" balance={balances.ip} accent="text-slate-900 dark:text-slate-100" />
        <div className={`flex h-full flex-col p-5 ${CARD}`}>
          <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Всего</div>
          <div className="mt-2 truncate text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            {balances.totalKopeks === null ? "Нет данных" : formatKopeks(balances.totalKopeks)}
          </div>
          <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">ООО + ИП</div>
        </div>
      </div>

      {/* Block 2 — update balance */}
      {canManage ? (
        <div className={`mb-6 p-5 ${CARD}`}>
          <div className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Внести остаток</div>
          {targetOptions.length === 0 ? (
            <div className="text-sm text-slate-500 dark:text-slate-400">Нет привязанных юрлиц. Привяжите ООО / ИП к клубу в настройках.</div>
          ) : (
            <BalanceForm targets={targetOptions} today={isoLocal(new Date())} />
          )}
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Вносить остатки может владелец, ген. директор или бухгалтер. Доступен только просмотр.
        </div>
      )}

      {/* Block 3 — history (read-only control log) */}
      <div className={`overflow-hidden ${CARD}`}>
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-200">
          История остатков
        </div>
        {history.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">Остатки ещё не вносились.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>Дата</Th>
                  <Th>Юрлицо</Th>
                  <Th>Клуб</Th>
                  <Th className="text-right">Остаток</Th>
                  <Th>Комментарий</Th>
                  <Th>Кто добавил</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {history.map((h) => (
                  <tr key={h.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <Td className="whitespace-nowrap">{dateFmt.format(h.snapshotDate)}</Td>
                    <Td className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">
                      {h.legalEntityName}{h.legalEntityType ? ` (${legalEntityTypeLabel(h.legalEntityType)})` : ""}
                    </Td>
                    <Td className="whitespace-nowrap">{h.clubName}</Td>
                    <Td className="whitespace-nowrap text-right font-medium text-slate-900 dark:text-slate-100">{formatKopeks(h.actualBalanceKopeks)}</Td>
                    <Td className="max-w-[18rem] truncate text-slate-500 dark:text-slate-400">{h.comment ?? "—"}</Td>
                    <Td className="whitespace-nowrap text-slate-500 dark:text-slate-400">{h.createdByName}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function BalanceCard({ label, balance, accent }: { label: string; balance: EntityBalance; accent: string }) {
  const has = balance.kopeks !== null;
  return (
    <div className={`flex h-full flex-col p-5 ${CARD}`}>
      <div className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-2 truncate text-3xl font-semibold tracking-tight ${has ? accent : "text-slate-400 dark:text-slate-500"}`}>
        {has ? formatKopeks(balance.kopeks as number) : "Нет данных"}
      </div>
      <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">{has ? updatedLabel(balance.latestDate) : "снимок не вносился"}</div>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th scope="col" className={`whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle text-sm text-slate-700 dark:text-slate-300 ${className ?? ""}`}>{children}</td>;
}
