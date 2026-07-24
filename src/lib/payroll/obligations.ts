// Employee ↔ company financial obligations (debts). Created when a closed period leaves
// a remainder (company owes employee) or an overpayment (employee owes company), and
// settled against a SPECIFIC obligation — never a faceless "прочий приход/расход".
// Dismissing an employee NEVER auto-writes-off their debt (spec §7): write-off is an
// explicit, permissioned, commented action.
import type { EmployeeFinancialObligation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/lib/auth";

export const OBLIGATION_DIRECTION_LABELS: Record<string, string> = {
  employee_owes_company: "Сотрудник должен компании",
  company_owes_employee: "Компания должна сотруднику",
};
export const OBLIGATION_STATUS_LABELS: Record<string, string> = {
  open: "Открыт",
  partially_settled: "Частично погашен",
  settled: "Погашен",
  written_off: "Списан",
};

/** Pure: the obligation implied by a calculation's remaining. remaining > 0 → the
 * company still owes the employee; remaining < 0 → the employee was overpaid. */
export function obligationFromRemaining(remainingKopeks: number):
  | { direction: "company_owes_employee" | "employee_owes_company"; reason: string; amountKopeks: number }
  | null {
  if (remainingKopeks > 0) return { direction: "company_owes_employee", reason: "salary_remainder", amountKopeks: remainingKopeks };
  if (remainingKopeks < 0) return { direction: "employee_owes_company", reason: "overpayment", amountKopeks: -remainingKopeks };
  return null;
}

/** Pure: apply a settlement to an outstanding balance. */
export function applySettlement(outstandingKopeks: number, amountKopeks: number): {
  appliedKopeks: number;
  newOutstandingKopeks: number;
  status: "partially_settled" | "settled";
} {
  const applied = Math.min(outstandingKopeks, Math.max(0, amountKopeks));
  const newOutstanding = Math.max(0, outstandingKopeks - applied);
  return { appliedKopeks: applied, newOutstandingKopeks: newOutstanding, status: newOutstanding <= 0 ? "settled" : "partially_settled" };
}

/** Only the accounting lead / owner may write a debt off — never automatic. */
export function canWriteOffObligation(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "owner" || r === "chief_accountant");
}
/** Who may record a settlement (money returning or being paid out). */
export function canSettleObligation(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "manager" || r === "regional_director" || r === "accountant" || r === "chief_accountant");
}

export type ObligationRow = EmployeeFinancialObligation;

/** Open/partially-settled obligations for the scope (club-filtered). */
export async function getOpenObligationsForScope(companyId: string, clubIds: string[]): Promise<ObligationRow[]> {
  if (clubIds.length === 0) return [];
  return prisma.employeeFinancialObligation.findMany({
    where: { companyId, clubId: { in: clubIds }, status: { in: ["open", "partially_settled"] } },
    orderBy: [{ createdAt: "desc" }],
  });
}

/** All obligations for one employee (any status), newest first. */
export async function getObligationsForEmployee(companyId: string, employeeId: string): Promise<ObligationRow[]> {
  return prisma.employeeFinancialObligation.findMany({
    where: { companyId, employeeId },
    orderBy: [{ createdAt: "desc" }],
  });
}
