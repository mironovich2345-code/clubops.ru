import { prisma } from "@/lib/prisma";
import { loadRecognizedExpenses } from "@/lib/finance/recognized-expense";
import { formatKopeks } from "@/lib/money";

export async function DemoSummary({ companyId, clubIds }: { companyId: string; clubIds: string[] }) {
  const where = { companyId, clubId: { in: clubIds } };
  const [sales, plans, expenses, budget] = await Promise.all([
    prisma.ofdDailySalesSummary.aggregate({ where: { ...where, date: { gte: "2026-11-01", lte: "2026-11-15" } }, _sum: { netTotalKopeks: true, incomeTotalKopeks: true, returnTotalKopeks: true } }),
    prisma.salesPlan.aggregate({ where: { ...where, month: "2026-11", planType: "total" }, _sum: { targetAmountKopeks: true } }),
    loadRecognizedExpenses({ companyId, allowedClubIds: clubIds, months: ["2026-11"] }),
    prisma.budget.aggregate({ where: { ...where, month: "2026-11" }, _sum: { limitAmountKopeks: true } }),
  ]);
  const net = sales._sum.netTotalKopeks ?? 0;
  const plan = plans._sum.targetAmountKopeks ?? 0;
  return <section className="mb-6 grid gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Демонстрационный период">
    <div className="sm:col-span-2 xl:col-span-4 text-sm font-medium">Продажи: 1–15 ноября 2026. Бюджеты и расходы: ноябрь, включая изменения вашего демосеанса.</div>
    <div><p className="text-xs">Выручка ОФД нетто</p><strong className="text-xl">{formatKopeks(net)}</strong><p className="text-xs">Приход {formatKopeks(sales._sum.incomeTotalKopeks ?? 0)} − фискальные возвраты {formatKopeks(sales._sum.returnTotalKopeks ?? 0)}</p></div>
    <div><p className="text-xs">План выручки / прогноз ноября</p><strong className="text-xl">{formatKopeks(net * 2)}</strong><p className="text-xs">План {formatKopeks(plan)} · {plan ? (net * 2 / plan * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "—"}% · линейно за 15 дней</p></div>
    <div><p className="text-xs">Признанные расходы</p><strong className="text-xl">{formatKopeks(expenses.totalKopeks)}</strong><p className="text-xs">Счета, расходы и подтверждённые начисления без повторного учёта оплат</p></div>
    <div><p className="text-xs">План расходов / условный прогноз</p><strong className="text-xl">{formatKopeks(expenses.totalKopeks * 2)}</strong><p className="text-xs">План {formatKopeks(budget._sum.limitAmountKopeks ?? 0)} · факт демосеанса × 2</p></div>
  </section>;
}
