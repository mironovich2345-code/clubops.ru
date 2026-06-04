import type { Sale } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import type { Role } from "@/lib/auth";

// Default sources shown in the create form. `source` is stored as TEXT (SQLite
// has no enums), so other values are technically allowed — these are the
// suggested defaults.
export const SALE_SOURCES = [
  "Абонементы",
  "Персональные тренировки",
  "Продления",
  "Заморозки",
  "Товары",
  "Прочее",
] as const;

// --- Accountant verification workflow ----------------------------------------
// A sale is created as pending_accountant; only an accountant/owner can confirm
// it into realized revenue (or reject it). Managers/owners may cancel their own
// pending sale. Only "confirmed" sales count toward dashboard revenue.

export type SaleStatus = "pending_accountant" | "confirmed" | "rejected" | "canceled";

export const SALE_STATUSES: SaleStatus[] = ["pending_accountant", "confirmed", "rejected", "canceled"];

export const SALE_STATUS_LABELS: Record<string, string> = {
  pending_accountant: "На проверке",
  confirmed: "Подтверждено",
  rejected: "Отклонено",
  canceled: "Отменено",
};

export type SaleAction = "confirm" | "reject" | "cancel";

export const SALE_ACTION_LABELS: Record<SaleAction, string> = {
  confirm: "Подтвердить",
  reject: "Отклонить",
  cancel: "Отменить",
};

export const SALE_ACTION_AUDIT: Record<SaleAction, string> = {
  confirm: "sale.confirmed",
  reject: "sale.rejected",
  cancel: "sale.canceled",
};

/** Actions that need an explicit confirmation in the UI. */
export const SALE_DESTRUCTIVE_ACTIONS: SaleAction[] = ["reject", "cancel"];

/** Only confirmed sales are realized revenue (dashboard, totals). */
export function isConfirmedSale(status: string): boolean {
  return status === "confirmed";
}

type SaleTransition = { ok: true; to: SaleStatus } | { ok: false; error: string };

/**
 * Pure decision table — the single source of truth for who may do what.
 *  - confirm: accountant or owner, on a pending sale. A non-owner may NOT
 *    confirm a sale they submitted (separation of duties; managers can't confirm
 *    at all). Owner may confirm any pending sale.
 *  - reject: accountant or owner, on a pending sale.
 *  - cancel: the creator or the owner, on a pending sale.
 */
export function applySaleAction(
  action: SaleAction,
  status: string,
  roles: readonly Role[],
  isCreator: boolean,
): SaleTransition {
  const isOwner = roles.includes("owner");
  const isAccountant = roles.includes("accountant");

  switch (action) {
    case "confirm":
      if (!(isAccountant || isOwner)) return { ok: false, error: "Недостаточно прав для подтверждения" };
      if (isCreator && !isOwner) return { ok: false, error: "Нельзя подтвердить собственную продажу" };
      if (status !== "pending_accountant") return { ok: false, error: "Подтвердить можно продажу на проверке" };
      return { ok: true, to: "confirmed" };

    case "reject":
      if (!(isAccountant || isOwner)) return { ok: false, error: "Недостаточно прав для отклонения" };
      if (status !== "pending_accountant") return { ok: false, error: "Отклонить можно продажу на проверке" };
      return { ok: true, to: "rejected" };

    case "cancel":
      if (status !== "pending_accountant") return { ok: false, error: "Отменить можно только продажу на проверке" };
      if (!(isOwner || isCreator)) return { ok: false, error: "Недостаточно прав для отмены" };
      return { ok: true, to: "canceled" };
  }
}

/** Actions the actor can currently perform — drives which buttons are shown. */
export function availableSaleActions(
  status: string,
  roles: readonly Role[],
  isCreator: boolean,
): SaleAction[] {
  return (Object.keys(SALE_ACTION_LABELS) as SaleAction[]).filter(
    (action) => applySaleAction(action, status, roles, isCreator).ok,
  );
}

/** A pending sale may be edited by its creator or an owner. */
export function canEditSale(status: string, roles: readonly Role[], isCreator: boolean): boolean {
  if (status !== "pending_accountant") return false;
  return roles.includes("owner") || isCreator;
}

export type SaleWithRelations = Sale & {
  club: { id: string; name: string; city: string };
  createdBy: { id: string; name: string };
};

export async function getSalesForScope(
  scope: DataScope,
): Promise<SaleWithRelations[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  return prisma.sale.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: { saleDate: "desc" },
    include: {
      club: true,
      createdBy: { select: { id: true, name: true } },
    },
  });
}

/** Single sale, scoped to the current access context (company + allowed clubs). */
export async function getSaleForContext(
  ctx: AccessContext,
  saleId: string,
): Promise<SaleWithRelations | null> {
  if (!ctx.selectedCompanyId) return null;
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { club: true, createdBy: { select: { id: true, name: true } } },
  });
  if (!sale) return null;
  if (sale.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(sale.clubId)) return null;
  return sale as SaleWithRelations;
}

type MonthRange = { start: number; end: number };

function monthRange(year: number, monthIndex: number): MonthRange {
  return {
    start: new Date(year, monthIndex, 1).getTime(),
    end: new Date(year, monthIndex + 1, 1).getTime(),
  };
}

function inRange(date: Date, range: MonthRange): boolean {
  const t = date.getTime();
  return t >= range.start && t < range.end;
}

export type SourceTotal = { source: string; amountKopeks: number };

export type SaleSummary = {
  currentMonthKopeks: number;
  previousMonthKopeks: number;
  changeKopeks: number;
  /** null when the previous month has no sales (percent is undefined) */
  changePercent: number | null;
  topSource: SourceTotal | null;
  /** current-month totals per source, sorted by amount desc */
  sourceTotals: SourceTotal[];
};

export function summarizeSales(
  sales: Array<{ amountKopeks: number; saleDate: Date; source: string }>,
  reference: Date,
): SaleSummary {
  const year = reference.getFullYear();
  const month = reference.getMonth();
  const current = monthRange(year, month);
  const previous = monthRange(year, month - 1);

  let currentMonthKopeks = 0;
  let previousMonthKopeks = 0;
  const bySource = new Map<string, number>();

  for (const s of sales) {
    if (inRange(s.saleDate, current)) {
      currentMonthKopeks += s.amountKopeks;
      bySource.set(s.source, (bySource.get(s.source) ?? 0) + s.amountKopeks);
    } else if (inRange(s.saleDate, previous)) {
      previousMonthKopeks += s.amountKopeks;
    }
  }

  const sourceTotals: SourceTotal[] = [...bySource.entries()]
    .map(([source, amountKopeks]) => ({ source, amountKopeks }))
    .sort((a, b) => b.amountKopeks - a.amountKopeks);

  const changeKopeks = currentMonthKopeks - previousMonthKopeks;
  const changePercent =
    previousMonthKopeks === 0 ? null : (changeKopeks / previousMonthKopeks) * 100;

  return {
    currentMonthKopeks,
    previousMonthKopeks,
    changeKopeks,
    changePercent,
    topSource: sourceTotals[0] ?? null,
    sourceTotals,
  };
}
