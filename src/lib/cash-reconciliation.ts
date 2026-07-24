// «Фактические деньги» — ежедневная сверка физически пересчитанных наличных управляющим
// с ОЖИДАЕМЫМ остатком (contour #2). Запись-подтверждение: деньги НЕ двигаются, ОФД НЕ
// переписывается. Ожидаемый остаток и OFD-наличные берутся из loadClubCashBalances —
// параллельный расчёт остатка НЕ создаётся.
import type { DailyCashReconciliation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/lib/auth";
import { loadClubCashBalances } from "@/lib/cash-collections";
import { getActiveClubLegalEntities } from "@/lib/legal-entities";

export const RECON_STATUSES = [
  "awaiting_input",
  "submitted",
  "discrepancy",
  "under_review",
  "regional_confirmed",
  "accounting_confirmed",
  "closed",
] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export const RECON_STATUS_LABELS: Record<string, string> = {
  awaiting_input: "Ожидает ввода",
  submitted: "Введено",
  discrepancy: "Есть расхождение",
  under_review: "На разборе",
  regional_confirmed: "Подтверждено регионалом",
  accounting_confirmed: "Подтверждено бухгалтером",
  closed: "Закрыто",
};

// Справочник причин расхождения (spec 2.3).
export const RECON_REASON_CODES = [
  "receipt_no_cash",
  "wrong_payment_method",
  "wrong_legal_entity",
  "unrecorded_expense",
  "unrecorded_deposit",
  "money_in_transit",
  "shortage",
  "surplus",
  "prior_day_error",
  "other",
] as const;
export type ReconReasonCode = (typeof RECON_REASON_CODES)[number];

export const RECON_REASON_LABELS: Record<string, string> = {
  receipt_no_cash: "Чек пробит, деньги не получены",
  wrong_payment_method: "Неверный способ оплаты",
  wrong_legal_entity: "Неверное юрлицо",
  unrecorded_expense: "Неучтённый расход",
  unrecorded_deposit: "Неучтённое внесение",
  money_in_transit: "Деньги в пути",
  shortage: "Недостача",
  surplus: "Излишек",
  prior_day_error: "Ошибка прошлого дня",
  other: "Другое",
};

const DEADLINE_HOUR = 12; // до 12:00 следующего дня по времени сервера (per-club TZ нет)

// --- pure helpers ------------------------------------------------------------
/** Начало локального календарного дня. */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
/** Предыдущий локальный день (бизнес-дата ежедневной сверки). */
export function yesterdayLocal(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
}
/** Дедлайн ввода: 12:00 следующего дня после бизнес-даты (локально). */
export function reconciliationDeadline(businessDate: Date): Date {
  return new Date(businessDate.getFullYear(), businessDate.getMonth(), businessDate.getDate() + 1, DEADLINE_HOUR, 0, 0, 0);
}
/** Просрочено: ещё ожидает ввода и прошёл дедлайн. */
export function isReconciliationOverdue(status: string, businessDate: Date, now: Date): boolean {
  return status === "awaiting_input" && now.getTime() > reconciliationDeadline(businessDate).getTime();
}
/** Введено вовремя, если подтверждено не позже дедлайна. */
export function submittedOnTime(businessDate: Date, submittedAt: Date): boolean {
  return submittedAt.getTime() <= reconciliationDeadline(businessDate).getTime();
}
export function reconciliationDifference(actualKopeks: number, expectedKopeks: number): number {
  return actualKopeks - expectedKopeks;
}
/** Отображаемый статус с учётом просрочки. */
export function displayReconStatus(r: Pick<DailyCashReconciliation, "status" | "businessDate">, now: Date): string {
  if (isReconciliationOverdue(r.status, r.businessDate, now)) return "Просрочено";
  return RECON_STATUS_LABELS[r.status] ?? r.status;
}

// --- capabilities (server-side) ---------------------------------------------
/** Управляющий/регионал вводят фактические деньги (свой клуб / регион). */
export function canSubmitReconciliation(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "manager" || r === "regional_director");
}
/** Регионал подтверждает причину расхождения. */
export function canRegionalReview(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "regional_director");
}
/** Бухгалтер подтверждает финансовое закрытие. */
export function canAccountingReview(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "accountant" || r === "chief_accountant");
}

// --- target for a club+day (expected + OFD reused from loadClubCashBalances) --
export type ReconTargetEntity = {
  legalEntityId: string;
  legalEntityType: "ooo" | "ip";
  name: string;
  ofdCashRevenueKopeks: number;
  expectedCashBalanceKopeks: number;
  existing: DailyCashReconciliation | null;
};

/**
 * Build the reconciliation targets for a club for the previous local day. Reuses the
 * existing fact-balance math (never recomputes a parallel total): expected =
 * cash{Ooo,Ip}FactBalance, OFD cash = cash{Ooo,Ip}OfdYesterday.
 */
export async function buildReconciliationTargets(
  companyId: string,
  clubId: string,
  now: Date = new Date(),
): Promise<{ businessDate: Date; entities: ReconTargetEntity[] }> {
  const businessDate = yesterdayLocal(now);
  const { balances, oooId, ipId, oooName, ipName } = await loadClubCashBalances(companyId, clubId, now);
  const existing = await prisma.dailyCashReconciliation.findMany({
    where: { companyId, clubId, businessDate },
  });
  const existingBy = new Map(existing.map((e) => [e.legalEntityId, e]));

  const entities: ReconTargetEntity[] = [];
  if (oooId) {
    entities.push({
      legalEntityId: oooId,
      legalEntityType: "ooo",
      name: oooName ?? "ООО",
      ofdCashRevenueKopeks: balances.cashOooOfdYesterday,
      expectedCashBalanceKopeks: balances.cashOooFactBalance,
      existing: existingBy.get(oooId) ?? null,
    });
  }
  if (ipId) {
    entities.push({
      legalEntityId: ipId,
      legalEntityType: "ip",
      name: ipName ?? "ИП",
      ofdCashRevenueKopeks: balances.cashIpOfdYesterday,
      expectedCashBalanceKopeks: balances.cashIpFactBalance,
      existing: existingBy.get(ipId) ?? null,
    });
  }
  return { businessDate, entities };
}

/** Reconciliations for a scope (club-filtered), newest business date first. */
export async function getReconciliationsForScope(
  companyId: string,
  clubIds: string[],
  opts?: { status?: string; discrepancyOnly?: boolean; limit?: number },
): Promise<DailyCashReconciliation[]> {
  if (clubIds.length === 0) return [];
  const where: import("@prisma/client").Prisma.DailyCashReconciliationWhereInput = { companyId, clubId: { in: clubIds } };
  if (opts?.status) where.status = opts.status;
  if (opts?.discrepancyOnly) where.differenceKopeks = { not: 0 };
  return prisma.dailyCashReconciliation.findMany({
    where,
    orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
    take: opts?.limit ?? 60,
  });
}

/** Single reconciliation scoped to company + accessible clubs. */
export async function getReconciliationForScope(
  companyId: string,
  clubIds: string[],
  id: string,
): Promise<DailyCashReconciliation | null> {
  const r = await prisma.dailyCashReconciliation.findUnique({ where: { id } });
  if (!r || r.companyId !== companyId || !clubIds.includes(r.clubId)) return null;
  return r;
}

/** Active ООО/ИП resolution for scoping the submit action. */
export async function resolveClubEntities(clubId: string) {
  return getActiveClubLegalEntities(clubId);
}
