// WAVE 2 — Salary budget planning panel. Shows the FIVE distinct numbers per club, labelled,
// never blended: Прогноз (A) · Бюджет (B) · Начислено (C) · Выплачено (D) · К выплате (R) +
// variance. Below, pending BudgetChangeProposal rows with approve/reject (owner/GD only). The
// forecast NEVER overwrites the budget from here — only an approved proposal does.
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import type { Role } from "@/lib/auth";
import {
  loadSalaryBudgetLines,
  canApproveBudgetChange,
  SALARY_BUDGET_SYNC_MODE_LABELS,
  isSyncMode,
  type SalaryBudgetSyncMode,
} from "@/lib/payroll/budget-linkage";
import { SalaryProposalActions } from "./SalaryProposalActions";

function pctLabel(p: number | null): string {
  if (p == null) return "— (прогноз неполный)";
  const sign = p > 0 ? "+" : "";
  return `${sign}${p.toFixed(1)}%`;
}

export async function SalaryBudgetPanel({
  companyId,
  clubIds,
  clubNames,
  month,
  roles,
}: {
  companyId: string;
  clubIds: string[];
  clubNames: Record<string, string>;
  month: string;
  roles: readonly Role[];
}) {
  if (clubIds.length === 0) return null;
  const atDate = new Date(`${month}-01T00:00:00`);

  const [lines, proposals, company] = await Promise.all([
    loadSalaryBudgetLines({ companyId, clubIds, month, atDate }),
    prisma.budgetChangeProposal.findMany({
      where: { companyId, clubId: { in: clubIds }, category: "salary", month, status: "pending" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { salaryBudgetSyncMode: true } }),
  ]);

  const canDecide = canApproveBudgetChange(roles);
  const syncMode: SalaryBudgetSyncMode = company && isSyncMode(company.salaryBudgetSyncMode) ? company.salaryBudgetSyncMode : "suggested";
  const nonZero = lines.filter((l) => l.forecastKopeks || l.budgetKopeks || l.accruedKopeks || l.paidKopeks || l.remainingKopeks);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Зарплата — планирование ({month})</h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          Синхронизация: {SALARY_BUDGET_SYNC_MODE_LABELS[syncMode]}
        </span>
      </div>

      {nonZero.length === 0 ? (
        <p className="text-sm text-slate-500">Нет данных по зарплате за месяц.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-700">
                <th className="py-2 pr-3">Клуб</th>
                <th className="px-3 py-2 text-right" title="Планируемый ФОТ из активных схем">Прогноз</th>
                <th className="px-3 py-2 text-right" title="Утверждённый лимит бюджета">Бюджет</th>
                <th className="px-3 py-2 text-right" title="Начислено в утверждённых периодах">Начислено</th>
                <th className="px-3 py-2 text-right" title="Фактически выплачено">Выплачено</th>
                <th className="px-3 py-2 text-right" title="Остаток к выплате">К выплате</th>
                <th className="px-3 py-2 text-right" title="Бюджет − Прогноз">Отклонение</th>
              </tr>
            </thead>
            <tbody>
              {nonZero.map((l) => (
                <tr key={l.clubId} className="border-b border-slate-100 dark:border-slate-800">
                  <td className="py-2 pr-3 font-medium text-slate-700 dark:text-slate-200">{clubNames[l.clubId] ?? l.clubId}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatKopeks(l.forecastKopeks)}
                    {l.forecastConfidence === "partial" && <span className="ml-1 text-amber-500" title="Прогноз неполный">*</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatKopeks(l.budgetKopeks)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatKopeks(l.accruedKopeks)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatKopeks(l.paidKopeks)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatKopeks(l.remainingKopeks)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${l.variance.varianceKopeks < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {formatKopeks(l.variance.varianceKopeks)} <span className="text-xs text-slate-400">({pctLabel(l.variance.variancePercent)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-400">
        Прогноз, бюджет, начисление и выплата — разные числа. Изменение схемы влияет только на прогноз; бюджет меняется
        лишь через согласованное предложение. «*» — прогноз неполный (есть переменная часть или несконфигурированная схема).
      </p>

      {proposals.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Предложения по изменению бюджета ЗП</h3>
          <ul className="space-y-2">
            {proposals.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800">
                <div className="text-sm text-slate-700 dark:text-slate-200">
                  <span className="font-medium">{clubNames[p.clubId] ?? p.clubId}</span>: {formatKopeks(p.currentLimitKopeks)} → {formatKopeks(p.proposedLimitKopeks)}
                  <span className="ml-2 text-xs text-slate-400">{p.reason}</span>
                </div>
                <SalaryProposalActions proposalId={p.id} canDecide={canDecide} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
