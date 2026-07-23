// Payroll capability gates (server-side). Layered on top of the existing Role model.
// Page VIEW access is granted via ROLE_PAGE_ACCESS ("payroll"); these gate the
// money-sensitive mutations within the payroll section.
import type { Role } from "@/lib/auth";

/**
 * Assign employees to clubs + edit an employee's payroll profile. Operational,
 * own-scope: regional director and manager — same band that manages the roster.
 */
export function canManagePayrollAssignments(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "regional_director" || r === "manager");
}

/**
 * Configure pay schemes (оклады, ставки, проценты) — money-sensitive, so it is
 * NARROWER than roster management: owner / general director / regional director /
 * chief accountant. Managers propose calculations but do NOT set the scheme itself,
 * and an ordinary accountant verifies rather than configures. (Assumption — flagged
 * as an open business question in docs/audits/payroll-module-audit.md.)
 */
export function canManagePaySchemes(roles: readonly Role[]): boolean {
  return roles.some(
    (r) => r === "owner" || r === "general_director" || r === "regional_director" || r === "chief_accountant",
  );
}
