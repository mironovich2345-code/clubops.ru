import { notFound } from "next/navigation";
import { isDemo } from "@/lib/demo/config";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";

export const dynamic = "force-dynamic";
export default async function ReconciliationPage() {
  if (!isDemo()) notFound();
  await requirePageAccess("ofd_sales");
  const ctx = (await getCurrentAccessContext())!;
  const rows = await prisma.ofdDailySalesSummary.findMany({ where: { companyId: ctx.selectedCompanyId!, clubId: { in: ctx.allowedClubIds } }, orderBy: [{ date: "asc" }, { clubId: "asc" }] });
  const clubs = await prisma.club.findMany({ where: { id: { in: ctx.allowedClubIds } } });
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">Сверка ОФД ↔ эквайринг ↔ CRM</h1>
    <p className="rounded-lg bg-amber-50 p-4 text-sm">Синтетическое дополнение демостенда. ОФД — сохранённые тестовые чеки. Эквайринг и CRM здесь показаны как расчётный эталон для этих чеков; внешних подключений и загрузки банковских данных нет. Это не реализованная интеграция с банком или CRM.</p>
    <div className="overflow-x-auto rounded-lg border bg-white"><table className="w-full text-left text-sm"><thead><tr>{["Дата", "Филиал", "Нетто ОФД", "Эталон CRM", "Безнал ОФД до возвратов", "Эталон эквайринга"].map(x => <th key={x} className="whitespace-nowrap p-3">{x}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.id} className="border-t"><td className="p-3">{r.date}</td><td className="p-3">{clubs.find(c => c.id === r.clubId)?.name}</td><td className="p-3">{formatKopeks(r.netTotalKopeks)}</td><td className="p-3">{formatKopeks(r.netTotalKopeks)}</td><td className="p-3">{formatKopeks(r.incomeElectronicKopeks)}</td><td className="p-3">{formatKopeks(r.incomeElectronicKopeks)}</td></tr>)}</tbody></table></div>
  </div>;
}
