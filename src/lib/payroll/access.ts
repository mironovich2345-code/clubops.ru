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

/**
 * Add/cancel a PayrollAdjustment (bonus / penalty / correction). Before the period is
 * locked (approved), the operational band may add bonuses/penalties. AFTER approval the
 * period is locked for direct edits and ONLY the accounting band may post corrections
 * (spec §5) — a manager can no longer change an approved calculation. A closed period is
 * rejected by the caller before this gate.
 */
export function canAddPayrollAdjustment(roles: readonly Role[], opts: { locked: boolean }): boolean {
  const accounting = roles.some((r) => r === "accountant" || r === "chief_accountant");
  if (opts.locked) return accounting;
  return accounting || roles.some((r) => r === "manager" || r === "regional_director");
}

/**
 * PROPOSE a change to a locked payroll parameter (STAGE 10). The regional director may
 * only PROPOSE — the change does not affect any calculation until a GD/owner approves it.
 * The proposer band deliberately excludes the reviewer band so no one applies their own
 * locked change directly.
 */
export function canProposePayrollChange(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "regional_director");
}

/**
 * REVIEW (approve / reject / return) a payroll change request (STAGE 11) — the decision
 * that actually applies a locked change. Reserved for general director and owner. The
 * caller additionally forbids reviewing one's OWN request (spec §18/§19).
 */
export function canReviewPayrollChange(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "general_director" || r === "owner");
}

/**
 * MANAGE OFD cashier → employee mappings (STAGE 13): confirm/assign/exclude/resolve
 * ambiguous. Regional director (own clubs) + general director + owner. A club manager sees
 * their confirmed mappings read-only and may propose a per-receipt assignment only.
 */
export function canManageCashierMapping(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "regional_director" || r === "general_director" || r === "owner");
}

/**
 * ACTIVATE / APPROVE a pay-scheme version (STAGE 12). A regional director may author and
 * submit draft versions but may NOT activate them in-place (spec §14); only owner / general
 * director / chief accountant commit a version live. `canManagePaySchemes` still gates who
 * can author drafts at all.
 */
export function canActivateScheme(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "owner" || r === "general_director" || r === "chief_accountant");
}

// --- role-aware payroll navigation (manager UX simplification) ---------------
// Roles that get the FULL payroll section (overview, schemes, periods list, advances,
// payments, regional). A user with ANY of these keeps the full toolbar.
const FULL_PAYROLL_NAV_ROLES: readonly Role[] = [
  "owner",
  "general_director",
  "regional_director",
  "chief_accountant",
  "accountant",
];

/**
 * Navigation mode for the payroll section, by capability (NOT by role name alone):
 *   "manager" — a pure club manager (управляющий): ONE working screen + Долги only.
 *   "full"    — owner / GD / regional / chief_accountant / accountant: the full toolbar.
 * A user who is manager AND (say) regional keeps the full toolbar.
 */
export function payrollNavMode(roles: readonly Role[]): "manager" | "full" {
  if (roles.some((r) => FULL_PAYROLL_NAV_ROLES.includes(r))) return "full";
  if (roles.some((r) => r === "manager")) return "manager";
  return "full";
}

/** True for the simplified club-manager view (one screen + Долги). */
export function isPayrollManagerView(roles: readonly Role[]): boolean {
  return payrollNavMode(roles) === "manager";
}

/**
 * VIEW the regional-director payroll (единый расчёт по городу). Money-sensitive and
 * NOT a club manager's concern — reserved for owner / GD / regional / chief_accountant.
 * Enforced server-side on the page AND on every regional action (spec §7/§16); a manager
 * cannot read it even by typing the URL.
 */
export function canViewRegionalPayroll(roles: readonly Role[]): boolean {
  return roles.some(
    (r) =>
      r === "owner" ||
      r === "general_director" ||
      r === "regional_director" ||
      r === "chief_accountant" ||
      r === "accountant",
  );
}
