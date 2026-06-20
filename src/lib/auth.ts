import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// Business role hierarchy (highest -> lowest authority):
// owner > general_director > regional_director > manager > accountant > marketer
export type Role =
  | "owner"
  | "general_director"
  | "regional_director"
  | "manager"
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
  general_director: ["dashboard", "analytics", "payments", "mandatory_payments", "balances", "employees", "sales", "budgets", "activity", "users", "settings"],
  regional_director: ["dashboard", "analytics", "expenses", "invoices", "payments", "mandatory_payments", "balances", "employees", "refunds", "budgets", "sales", "documents", "activity", "users"],
  // Manager: operational, own-club only. No network analytics financials and no
  // audit/activity log.
  manager: ["dashboard", "analytics", "expenses", "invoices", "employees", "refunds", "budgets", "sales", "documents"],
  // Accountant lands on a dedicated workspace (рабочий стол) instead of the owner
  // dashboard / analytics, which are not part of the accountant's job.
  accountant: ["workspace", "expenses", "invoices", "payments", "mandatory_payments", "balances", "employees", "refunds", "budgets", "sales", "documents", "activity"],
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
export type Capability = "operational.create" | "sales_plan.manage" | "budget.manage" | "mandatory_payment.manage";

const ROLE_CAPABILITIES: Record<Role, ReadonlyArray<Capability>> = {
  owner: ["budget.manage", "mandatory_payment.manage"],
  general_director: ["sales_plan.manage", "budget.manage", "mandatory_payment.manage"],
  regional_director: ["operational.create"],
  manager: ["operational.create"],
  accountant: [],
  marketer: [],
};

export function can(roles: readonly Role[], capability: Capability): boolean {
  return roles.some((role) => ROLE_CAPABILITIES[role]?.includes(capability));
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
 * (Content-Disposition: attachment). Currently only the accountant. The future
 * chief_accountant role must be added here in a later task — keep this the single
 * source of truth so the accounting download capability lives in one place.
 * Every other role may still VIEW documents inline (no explicit download).
 */
export function canDownloadDocuments(roles: readonly Role[]): boolean {
  // TODO(chief_accountant): add "chief_accountant" here when that role lands.
  return roles.includes("accountant");
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
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "club_ops_session";
const SESSION_TTL_DAYS = 30;
// SESSION_SECRET keys the token HMAC: a leaked tokenHash can't be reversed into
// a usable cookie without the secret. Set it in production (see .env.example).
// Resolved lazily so production fails fast on the first auth request when the
// secret is missing, without throwing during `next build` (which sets
// NODE_ENV=production but never hashes a token at build time).
function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }
  return "dev-insecure-session-secret";
}

// Exported so invite tokens use the same keyed hash (raw token never stored).
export function hashToken(token: string): string {
  return createHmac("sha256", sessionSecret()).update(token).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  if (!session.user.isActive) return null;

  const u = session.user;
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

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.passwordHash) {
    return { ok: false, error: "Неверный email или пароль" };
  }
  if (!user.isActive) {
    return { ok: false, error: "Учётная запись отключена" };
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { ok: false, error: "Неверный email или пароль" };
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession(user.id);
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    store.delete(SESSION_COOKIE);
  }
}
