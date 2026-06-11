// Mandatory recurring/one-time payments (rent, salary, cleaning, …). The plans
// feed the payment calendar via PaymentObligation (see payment-obligations.ts).
// Allowed enum-like values are enforced here (SQLite stores them as TEXT).
import { prisma } from "@/lib/prisma";
import type { DataScope, AccessContext } from "@/lib/access";
import {
  MANDATORY_PAYMENT_CATEGORIES,
  MANDATORY_PAYMENT_CATEGORY_LABELS,
} from "@/lib/payment-obligations";

export { MANDATORY_PAYMENT_CATEGORIES, MANDATORY_PAYMENT_CATEGORY_LABELS };

export const MANDATORY_RECURRENCES = [
  { key: "monthly", label: "Ежемесячно" },
  { key: "none", label: "Разовый" },
] as const;
export const MANDATORY_RECURRENCE_LABELS: Record<string, string> = Object.fromEntries(
  MANDATORY_RECURRENCES.map((r) => [r.key, r.label]),
);

export const MANDATORY_STATUSES = [
  { key: "planned", label: "Активен" },
  { key: "paused", label: "На паузе" },
  { key: "canceled", label: "Отменён" },
] as const;
export const MANDATORY_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  MANDATORY_STATUSES.map((s) => [s.key, s.label]),
);

export const MANDATORY_CATEGORY_KEYS = new Set(MANDATORY_PAYMENT_CATEGORIES.map((c) => c.key));

export function mandatoryCategoryLabel(key: string): string {
  return MANDATORY_PAYMENT_CATEGORY_LABELS[key] ?? key;
}

export function isValidRecurrence(v: string): v is "monthly" | "none" {
  return v === "monthly" || v === "none";
}

export type MandatoryPaymentRow = {
  id: string;
  clubId: string;
  clubName: string;
  category: string;
  title: string;
  amountKopeks: number;
  dueDayOfMonth: number | null;
  dueDate: Date | null;
  recurrence: string;
  responsibleName: string | null;
  status: string;
  isActive: boolean;
  notes: string | null;
};

/** All mandatory payment plans visible in the scope (companyId + allowed clubs). */
export async function getMandatoryPaymentsForScope(scope: DataScope): Promise<MandatoryPaymentRow[]> {
  if (!scope.company || scope.clubIds.length === 0) return [];
  const rows = await prisma.mandatoryPaymentPlan.findMany({
    where: { companyId: scope.company.id, clubId: { in: scope.clubIds } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { club: { select: { name: true } }, responsible: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    clubName: r.club.name,
    category: r.category,
    title: r.title,
    amountKopeks: r.amountKopeks,
    dueDayOfMonth: r.dueDayOfMonth,
    dueDate: r.dueDate,
    recurrence: r.recurrence,
    responsibleName: r.responsible?.name ?? null,
    status: r.status,
    isActive: r.isActive,
    notes: r.notes,
  }));
}

/** Single plan for an edit form, scoped to the caller's company + allowed clubs. */
export async function getMandatoryPaymentForContext(ctx: AccessContext, id: string) {
  if (!ctx.selectedCompanyId) return null;
  const row = await prisma.mandatoryPaymentPlan.findUnique({ where: { id } });
  if (!row || row.companyId !== ctx.selectedCompanyId) return null;
  if (!ctx.allowedClubIds.includes(row.clubId)) return null;
  return row;
}
