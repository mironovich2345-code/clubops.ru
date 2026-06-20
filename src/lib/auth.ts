import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";
import { getValidSession, revokeCurrentSession } from "@/lib/session";

// Business role hierarchy (highest -> lowest authority):
// owner > general_director > regional_director > manager > chief_accountant >
// accountant > marketer
//
// chief_accountant (Главный бухгалтер) is the accounting-contour lead: it
// inherits every ordinary accountant operational permission (see
// EFFECTIVE_ROLE_EXPANSION) and additionally owns the month-close / controlled
// reopen workflow. It deliberately does NOT receive Dashboard, Analytics or any
// management capability.
export type Role =
  | "owner"
  | "general_director"
  | "regional_director"
  | "manager"
  | "chief_accountant"
  | "accountant"
  | "marketer";

export type AppPage =
  | "workspace"
  | "dashboard"
  | "analytics"
  | "expenses"
  | "invoices"
  | "payments"
  | "mandatory_payments"
  | "balances"
  | "employees"
  | "refunds"
  | "budgets"
  | "sales"
  | "documents"
  | "activity"
  | "users"
  | "settings";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

// VIEW access per role. Operational create/upload is a separate capability (see
// ROLE_CAPABILITIES) so an owner/general_director can VIEW invoices/expenses but
// not create them.
const ROLE_PAGE_ACCESS: Record<Role, ReadonlyArray<AppPage>> = {
  owner: ["dashboard", "analytics", "expenses", "invoices", "payments", "mandatory_payments", "balances", "employees", "refunds", "budgets", "sales", "activity", "users", "settings"],
  // GD additionally gets read-only strategic Expense/Invoice analytics (same as
  // owner). Operational mutation stays blocked by capabilities — page access does
  // not grant create/edit/approve (see canCreateOperational / canMutateOperationalRecords).
  general_director: ["dashboard", "analytics", "expenses", "invoices", "payments", "mandatory_payments", "balances", "employees", "sales", "budgets", "activity", "users", "settings"],
  regional_director: ["dashboard", "analytics", "expenses", "invoices", "payments", "mandatory_payments", "balances", "employees", "refunds", "budgets", "sales", "documents", "activity", "users"],
  // Manager: operational, own-club only. No network analytics financials and no
  // audit/activity log.
  manager: ["dashboard", "analytics", "expenses", "invoices", "employees", "refunds", "budgets", "sales", "documents"],
  // Accountant lands on a dedicated workspace (рабочий стол) instead of the owner
  // dashboard / analytics, which are not part of the accountant's job.
  accountant: ["workspace", "expenses", "invoices", "payments", "mandatory_payments", "balances", "employees", "refunds", "budgets", "sales", "documents", "activity"],
  // Chief accountant: identical page surface to the accountant (workspace-based,
  // no Dashboard / Analytics). The extra month-management controls are gated by
  // capabilities, not by page access.
  chief_accountant: ["workspace", "expenses", "invoices", "payments", "mandatory_payments", "balances", "employees", "refunds", "budgets", "sales", "documents", "activity"],
  // Marketer: limited analytics (sales / plans / advertising only); no other
  // financial pages.
  marketer: ["dashboard", "analytics"],
};

// Capabilities gate actions beyond page visibility (enforced server-side):
//  - "operational.create": create invoices/expenses/refunds/sales/imports
//    (managers + regional directors only — NOT owners/GD/accountants/marketers).
//  - "sales_plan.manage": create/update sales plans (general director only).
//  - "budget.manage": set/update monthly budget limits — strategic limits, so
//    owner + general director only (regional directors view but cannot edit).
//  - "mandatory_payment.manage": create/edit/pause/cancel mandatory payment
//    plans — owner + general director (accountant / regional view only).
//  Accounting contour + controlled month workflow capabilities:
//  - "accounting.workspace.view": the accounting рабочий стол (accountant + CA).
//  - "accounting.documents.view" / ".download": view inline / explicitly download
//    supporting accounting documents (accountant + CA).
//  - "accounting.operations.manage": verify/confirm expenses, invoices, refunds,
//    sales reports — the accountant's operational job (accountant + CA).
//  - "month.close": close a month — Chief Accountant ONLY.
//  - "month.reopen.request": create a reopening request — Chief Accountant ONLY.
//  - "month.reopen.approve": approve/reject a reopening request — Owner ONLY.
//  - "month.reopen.execute": execute an approved reopening — Chief Accountant ONLY.
//  - "shared_expenses.manage": future shared network-expense allocation — nobody
//    yet (TODO: wire to the accounting contour when that feature lands).
export type Capability =
  | "operational.create"
  | "sales_plan.manage"
  | "budget.manage"
  | "mandatory_payment.manage"
  | "accounting.workspace.view"
  | "accounting.documents.view"
  | "accounting.documents.download"
  | "accounting.operations.manage"
  | "month.close"
  | "month.reopen.request"
  | "month.reopen.approve"
  | "month.reopen.execute"
  | "shared_expenses.manage";

const ACCOUNTING_BASE: ReadonlyArray<Capability> = [
  "accounting.workspace.view",
  "accounting.documents.view",
  "accounting.documents.download",
  "accounting.operations.manage",
];

const ROLE_CAPABILITIES: Record<Role, ReadonlyArray<Capability>> = {
  owner: ["budget.manage", "mandatory_payment.manage", "month.reopen.approve"],
  general_director: ["sales_plan.manage", "budget.manage", "mandatory_payment.manage"],
  regional_director: ["operational.create"],
  manager: ["operational.create"],
  // Ordinary accountant: accounting operations + documents, but NO month control.
  accountant: [...ACCOUNTING_BASE],
  // Chief accountant: accounting base + the full month-close / controlled-reopen
  // workflow. shared_expenses.manage is intentionally NOT granted yet.
  chief_accountant: [...ACCOUNTING_BASE, "month.close", "month.reopen.request", "month.reopen.execute"],
  marketer: [],
};

export function can(roles: readonly Role[], capability: Capability): boolean {
  return roles.some((role) => ROLE_CAPABILITIES[role]?.includes(capability));
}

// --- Strategic vs. operational separation -----------------------------------
// Owner and General Director are STRATEGIC roles: they view analytics and (for
// GD) set plans/budgets, but they never create or edit operational records.
// These roles actually execute operational mutations on records:
const OPERATIONAL_ROLES: readonly Role[] = ["regional_director", "manager", "accountant", "chief_accountant"];

/** True if the actor holds an operational role (may mutate operational records).
 * Owner / general_director (strategic, read-only) and marketer are excluded. */
export function canMutateOperationalRecords(roles: readonly Role[]): boolean {
  return roles.some((role) => OPERATIONAL_ROLES.includes(role));
}

/** True if the actor is a strategic role (owner / general director). Used to
 * present read-only analytical views and to hide operational controls. */
export function isStrategicRole(roles: readonly Role[]): boolean {
  return roles.includes("owner") || roles.includes("general_director");
}

export const STRATEGIC_READONLY_ERROR =
  "Стратегическая роль работает в режиме просмотра и не изменяет операционные данные";

// --- Budget-overrun approval by category ------------------------------------
// General Director may approve a budget overrun ONLY for advertising and salary.
// Owner approves any category; regional director approves any category for its
// assigned clubs (club scope is enforced separately by getManageableClubIds).
export const GD_OVERRUN_CATEGORIES: readonly string[] = ["advertising", "salary"];
export const GD_OVERRUN_CATEGORY_ERROR =
  "Генеральный директор может согласовывать превышение бюджета только по рекламе и зарплатам";

export function canApproveBudgetOverrunForCategory(roles: readonly Role[], category: string): boolean {
  if (roles.includes("owner") || roles.includes("regional_director")) return true;
  if (roles.includes("general_director")) return GD_OVERRUN_CATEGORIES.includes(category);
  return false;
}

// Effective-role expansion: a stored role can imply additional effective roles
// for permission resolution. Chief Accountant inherits every ordinary accountant
// permission (page access + the many `roles.includes("accountant")` checks)
// without scattering chief-specific conditions across the codebase. Applied once
// in access.effectiveRolesInCompany.
const EFFECTIVE_ROLE_EXPANSION: Partial<Record<Role, ReadonlyArray<Role>>> = {
  chief_accountant: ["accountant"],
};

export function expandEffectiveRoles(roles: readonly Role[]): Role[] {
  const set = new Set<Role>(roles);
  for (const r of roles) for (const extra of EFFECTIVE_ROLE_EXPANSION[r] ?? []) set.add(extra);
  return [...set];
}

// --- Month-close / controlled-reopen capability helpers (server-enforced) ---
/** Close a month — Chief Accountant only. */
export function canCloseMonth(roles: readonly Role[]): boolean {
  return can(roles, "month.close");
}
/** Create a month-reopen request — Chief Accountant only. */
export function canRequestMonthReopen(roles: readonly Role[]): boolean {
  return can(roles, "month.reopen.request");
}
/** Approve/reject a month-reopen request — Owner only. */
export function canApproveMonthReopen(roles: readonly Role[]): boolean {
  return can(roles, "month.reopen.approve");
}
/** Execute an approved month-reopen request — Chief Accountant only. */
export function canExecuteMonthReopen(roles: readonly Role[]): boolean {
  return can(roles, "month.reopen.execute");
}

/** Create/upload operational records (invoices, expenses, refunds, sales, imports). */
export function canCreateOperational(roles: readonly Role[]): boolean {
  return can(roles, "operational.create");
}

/** Create/update sales plans (general director). */
export function canManageSalesPlans(roles: readonly Role[]): boolean {
  return can(roles, "sales_plan.manage");
}

/** Set/update monthly budget limits (owner / general director). */
export function canManageBudgets(roles: readonly Role[]): boolean {
  return can(roles, "budget.manage");
}

/** Create/edit/pause/cancel mandatory payment plans (owner / general director). */
export function canManageMandatoryPayments(roles: readonly Role[]): boolean {
  return can(roles, "mandatory_payment.manage");
}

/** Record cash-balance snapshots (owner / general director / accountant). Regional
 * directors and others are view-only. Not a capability flag — balances are a
 * dedicated control with its own role set. */
export function canManageBalances(roles: readonly Role[]): boolean {
  return roles.includes("owner") || roles.includes("general_director") || roles.includes("accountant");
}

/**
 * Accounting contour: who may explicitly DOWNLOAD a supporting document
 * (Content-Disposition: attachment) — accountant + chief accountant, via the
 * accounting.documents.download capability. Every other role may still VIEW
 * documents inline (no explicit download).
 */
export function canDownloadDocuments(roles: readonly Role[]): boolean {
  return can(roles, "accounting.documents.download");
}

export function canAccessPage(role: Role, page: AppPage): boolean {
  return ROLE_PAGE_ACCESS[role].includes(page);
}

export function pagesForRole(role: Role): ReadonlyArray<AppPage> {
  return ROLE_PAGE_ACCESS[role];
}

export function landingPageForRole(role: Role): AppPage {
  return ROLE_PAGE_ACCESS[role][0];
}

function asRole(role: string): Role {
  return role in ROLE_PAGE_ACCESS ? (role as Role) : "manager";
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---------------------------------------------------------------------------
// Sessions (DB-backed, httpOnly cookie holding a random token)
//
// The session lifecycle (creation, validation, revocation, listing, cleanup)
// lives in @/lib/session. hashToken lives in @/lib/tokens. They are re-exported
// here so existing import sites keep working.
// ---------------------------------------------------------------------------

// Re-exported so existing import sites (invites) keep working. A Session is now
// created ONLY by the OTP verification step (lib/login-challenge), never here.
export { hashToken };

/**
 * The current authenticated user, or null. Resolution is fully revocation-aware:
 * it validates the session token, that the session is not revoked, not expired,
 * and that the user is active (delegated to getValidSession). A fresh DB read on
 * every call — there is NO cross-request caching of the user/session (Part 5).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const valid = await getValidSession();
  if (!valid) return null;
  const u = valid.user;
  return { id: u.id, email: u.email, name: u.name, role: asRole(u.role) };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

// Effective-role helpers. Page access is driven by the roles a user actually
// holds in the selected scope (CompanyUserAccess/ClubUserAccess), never by the
// global User.role. See getCurrentAccessContext in src/lib/access.ts.
const ROLE_PRIORITY: readonly Role[] = [
  "owner",
  "general_director",
  "regional_director",
  "manager",
  "chief_accountant",
  "accountant",
  "marketer",
];

export function highestRole(roles: readonly Role[]): Role | null {
  for (const role of ROLE_PRIORITY) {
    if (roles.includes(role)) return role;
  }
  return null;
}

export function canAnyRoleAccessPage(roles: readonly Role[], page: AppPage): boolean {
  return roles.some((role) => canAccessPage(role, page));
}

export function isKnownRole(role: string): role is Role {
  return role in ROLE_PAGE_ACCESS;
}

export type AuthResult = { ok: boolean; error?: string };
export type PasswordResult =
  | { ok: true; user: { id: string; email: string; isActive: boolean } }
  | { ok: false; error: string };

const INVALID_CREDENTIALS = "Неверный email или пароль";

/**
 * STEP 1 of login: verify email + password ONLY. Never creates a Session — a
 * Session is created exclusively after email OTP verification (see
 * lib/login-challenge). Uses one generic message for every failure (missing
 * user, no password, inactive, wrong password) so login does not enumerate
 * accounts. An inactive user is rejected here and never receives an OTP.
 */
export async function verifyLoginPassword(email: string, password: string): Promise<PasswordResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.passwordHash || !user.isActive) {
    return { ok: false, error: INVALID_CREDENTIALS };
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { ok: false, error: INVALID_CREDENTIALS };
  }
  return { ok: true, user: { id: user.id, email: user.email, isActive: user.isActive } };
}

/**
 * Sign out: soft-revoke the current Session row AND clear the cookie (never just
 * the cookie, which would leave a valid DB session). Idempotent — calling it
 * again with no/invalid cookie is a no-op.
 */
export async function signOut(): Promise<void> {
  await revokeCurrentSession("signed_out");
}
