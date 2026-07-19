import { redirect } from "next/navigation";

// Legacy route. Контрольные остатки задаются ТОЛЬКО в Финансы → Инкассация
// (/collections) — единственный писатель контрольной точки BalanceSnapshot, которую
// использует движок фактических остатков. Эта страница больше не показывает форму
// создания/редактирования и перенаправляет на /collections. Модель BalanceSnapshot и
// история контрольных остатков в /collections не тронуты.
export const dynamic = "force-dynamic";

export default async function BalancesPage() {
  redirect("/collections");
}
