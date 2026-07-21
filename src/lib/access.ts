import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import {
  getCurrentUser,
  canAnyRoleAccessPage,
  highestRole,
  landingPageForRole,
  isKnownRole,
  expandEffectiveRoles,
  type CurrentUser,
  type Role,
  type AppPage,
} from "@/lib/auth";

// Company-scoped and club-scoped access live in CompanyUserAccess / ClubUserAccess.
// The legacy global User.role and UserClubAccess remain in place so existing
// modules keep working; this layer is the future-proof, company-isolated model.

export const COMPANY_ROLES = [
  "owner",
  "general_director",
  "regional_director",
  "manager",
  "chief_accountant",
  "accountant",
  "marketer",
] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const CLUB_ROLES = ["regional_director", "manager", "accountant"] as const;
export type ClubRole = (typeof CLUB_ROLES)[number];

// Platform superadmin is represented in code only (no UI yet). A superadmin is a
// User whose global role is "superadmin"; such a user may bypass company
// isolation in future tooling.
export function isPlatformSuperadmin(role: string): boolean {
  return role === "superadmin";
}

// Management-authority hierarchy used by userHasCompanyRole/userHasClubRole.
// Deliberately NOT mapping owner/general_director onto operational roles: an
// owner is a strategic viewer, not an operational executor (operational create
// is gated by the "operational.create" capability, not by role implication).
// A regional director keeps manager functionality (rule 6).
const ROLE_IMPLICATIONS: Record<string, readonly string[]> = {
  owner: ["owner"],
  general_director: ["general_director"],
  regional_director: ["regional_director", "manager"],
  manager: ["manager"],
  // Chief accountant satisfies any ordinary-accountant authority check.
  chief_accountant: ["chief_accountant", "accountant"],
  accountant: ["accountant"],
  marketer: ["marketer"],
};

function roleSatisfies(held: string, required: string): boolean {
  return (ROLE_IMPLICATIONS[held] ?? [held]).includes(required);
}

function anyRoleSatisfies(held: string[], required: readonly string[]): boolean {
  return held.some((h) => required.some((r) => roleSatisfies(h, r)));
}

/**
 * Distinct companies the user has any access to — via a company-level role OR a
 * club-level role (a club manager operates inside that club's company). Without
 * the club-derived companies, an invited club manager would have no scope and be
 * wrongly sent to onboarding.
 */
export async function getUserCompanies(userId: string) {
  const [companyRows, clubRows] = await Promise.all([
    prisma.companyUserAccess.findMany({ where: { userId }, include: { company: true } }),
    prisma.clubUserAccess.findMany({
      where: { userId },
      include: { club: { include: { company: true } } },
    }),
  ]);
  const byId = new Map<string, (typeof companyRows)[number]["company"]>();
  for (const row of companyRows) byId.set(row.companyId, row.company);
  for (const row of clubRows) byId.set(row.club.companyId, row.club.company);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Clubs the user can access, optionally scoped to one company.
 * Access = company-level access (covers every club in that company)
 *          OR an explicit club-level role.
 */
export async function getUserClubs(userId: string, companyId?: string, includeArchived = false) {
  const [companyAccess, clubAccess] = await Promise.all([
    prisma.companyUserAccess.findMany({ where: { userId }, select: { companyId: true } }),
    prisma.clubUserAccess.findMany({ where: { userId }, select: { clubId: true } }),
  ]);

  const companyIds = [...new Set(companyAccess.map((a) => a.companyId))];
  const clubIds = [...new Set(clubAccess.map((a) => a.clubId))];

  const accessible = {
    OR: [{ companyId: { in: companyIds } }, { id: { in: clubIds } }],
  };
  // Archived clubs are hidden from normal selectors (scope switcher, new
  // operations); pass includeArchived for management views like /settings.
  const filters: Array<Record<string, unknown>> = [accessible];
  if (companyId) filters.push({ companyId });
  if (!includeArchived) filters.push({ isActive: true });

  return prisma.club.findMany({
    where: { AND: filters },
    orderBy: { name: "asc" },
    include: { company: true },
  });
}

// Current data scope (company + optional club) used to filter every query and
// guard every write. There is no UI selector yet — selection is server-side.
export type DataScope = {
  company: { id: string; name: string } | null;
  // Auto-selected when the user has exactly one accessible club in the company.
  club: { id: string; name: string } | null;
  // Every club id the user may see in the current company (drives query filters).
  clubIds: string[];
};

/**
 * Resolves the company/club the current user operates in, auto-selecting when
 * there is only one option:
 *  - one accessible company -> selected
 *  - one accessible club    -> selected
 *
 * A platform superadmin is scoped to the first company but reaches every club in
 * it. A regular owner is limited to companies where they hold CompanyUserAccess —
 * there is no global all-data access.
 */
export const SCOPE_COMPANY_COOKIE = "scope_company";
export const SCOPE_CLUB_COOKIE = "scope_club";

export async function getCurrentCompanyAndClub(user: CurrentUser): Promise<DataScope> {
  const superadmin = isPlatformSuperadmin(user.role);

  const companies = superadmin
    ? await prisma.company.findMany({ orderBy: { name: "asc" } })
    : await getUserCompanies(user.id);

  if (companies.length === 0) return { company: null, club: null, clubIds: [] };

  const store = await cookies();
  // Selected company from the scope switcher (falls back to the first accessible).
  const cookieCompanyId = store.get(SCOPE_COMPANY_COOKIE)?.value;
  const company = companies.find((c) => c.id === cookieCompanyId) ?? companies[0];

  const clubs = superadmin
    ? await prisma.club.findMany({ where: { companyId: company.id, isActive: true }, orderBy: { name: "asc" } })
    : await getUserClubs(user.id, company.id);

  // A specific club narrows the scope; otherwise the dashboard is company-level
  // (all accessible clubs). A single accessible club is auto-selected.
  const cookieClubId = store.get(SCOPE_CLUB_COOKIE)?.value;
  const selected =
    clubs.find((c) => c.id === cookieClubId) ?? (clubs.length === 1 ? clubs[0] : null);
  const clubIds = selected ? [selected.id] : clubs.map((c) => c.id);

  return {
    company: { id: company.id, name: company.name },
    club: selected ? { id: selected.id, name: selected.name } : null,
    clubIds,
  };
}

/** Club rows the user may pick/see in the current scope (dropdowns, comparison). */
export async function getClubsInScope(scope: DataScope) {
  if (!scope.company || scope.clubIds.length === 0) return [];
  return prisma.club.findMany({
    where: { id: { in: scope.clubIds } },
    orderBy: { name: "asc" },
  });
}

export type AccessibleClubRow = {
  clubId: string;
  clubName: string;
  city: string;
  companyId: string;
  companyName: string;
  role: Role | null;
  isActive: boolean;
  archivedAt: Date | null;
};

/**
 * Every club the user may see (including archived), annotated with the company,
 * the user's effective role for that club, and active/archived status. Owners
 * see all clubs in their companies; club-scoped roles see only assigned clubs.
 * Drives the "Доступные клубы" overview in /settings.
 */
export async function getAccessibleClubsDetailed(user: CurrentUser): Promise<AccessibleClubRow[]> {
  const [clubs, companyRows, clubRows] = await Promise.all([
    getUserClubs(user.id, undefined, true),
    prisma.companyUserAccess.findMany({ where: { userId: user.id }, select: { companyId: true, role: true } }),
    prisma.clubUserAccess.findMany({ where: { userId: user.id }, select: { clubId: true, role: true } }),
  ]);

  const companyRoles = new Map<string, string[]>();
  for (const r of companyRows) {
    companyRoles.set(r.companyId, [...(companyRoles.get(r.companyId) ?? []), r.role]);
  }
  const clubRoleMap = new Map<string, string[]>();
  for (const r of clubRows) {
    clubRoleMap.set(r.clubId, [...(clubRoleMap.get(r.clubId) ?? []), r.role]);
  }

  return clubs.map((c) => {
    const roles = [
      ...(companyRoles.get(c.companyId) ?? []),
      ...(clubRoleMap.get(c.id) ?? []),
    ].filter(isKnownRole);
    return {
      clubId: c.id,
      clubName: c.name,
      city: c.city,
      companyId: c.companyId,
      companyName: c.company.name,
      role: highestRole(roles),
      isActive: c.isActive,
      archivedAt: c.archivedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Effective access context — the single source of truth for navigation and
// protected page access. Global User.role is NOT used here.
// ---------------------------------------------------------------------------

export type AccessContext = {
  user: CurrentUser;
  selectedCompanyId: string | null;
  selectedClubId: string | null;
  effectiveRole: Role | null;
  effectiveRoles: Role[];
  allowedCompanyIds: string[];
  allowedClubIds: string[];
};

// Roles that see EVERY operational record of their assigned clubs. A pure
// manager (none of these) sees only records they created — enforced by
// managerOwnFilter() at every list / aggregate / single-record scope check.
const ELEVATED_VISIBILITY_ROLES: readonly Role[] = [
  "regional_director", "general_director", "owner", "accountant", "chief_accountant",
];

/** True when the actor is a plain manager with no elevated (all-club) role. */
export function isManagerOnlyVisibility(roles: readonly Role[]): boolean {
  return roles.includes("manager") && !roles.some((r) => ELEVATED_VISIBILITY_ROLES.includes(r));
}

/**
 * Prisma `where` fragment that limits a query to the actor's OWN records when
 * they are a manager-only actor; an empty fragment (no restriction) otherwise.
 * Spread into an expense/invoice/refund `where` to keep managers own-only in
 * lists, cards, aggregates and counters without leaking siblings' records.
 */
export function managerOwnFilter(ctx: AccessContext): { createdByUserId?: string } {
  return isManagerOnlyVisibility(ctx.effectiveRoles) ? { createdByUserId: ctx.user.id } : {};
}

/** True when a manager-only actor may NOT see this record (created by someone
 * else). Used by the single-record context loaders to reject direct-URL access. */
export function managerCannotSeeRecord(ctx: AccessContext, record: { createdByUserId: string }): boolean {
  return isManagerOnlyVisibility(ctx.effectiveRoles) && record.createdByUserId !== ctx.user.id;
}

async function listAccessibleCompanyIds(user: CurrentUser): Promise<string[]> {
  if (isPlatformSuperadmin(user.role)) {
    const all = await prisma.company.findMany({ select: { id: true } });
    return all.map((c) => c.id);
  }
  const [companyRows, clubRows] = await Promise.all([
    prisma.companyUserAccess.findMany({ where: { userId: user.id }, select: { companyId: true } }),
    prisma.clubUserAccess.findMany({
      where: { userId: user.id },
      select: { club: { select: { companyId: true } } },
    }),
  ]);
  return [
    ...new Set([
      ...companyRows.map((r) => r.companyId),
      ...clubRows.map((r) => r.club.companyId),
    ]),
  ];
}

async function effectiveRolesInCompany(user: CurrentUser, companyId: string): Promise<Role[]> {
  if (isPlatformSuperadmin(user.role)) return ["owner"];
  const [companyRows, clubRows] = await Promise.all([
    prisma.companyUserAccess.findMany({ where: { userId: user.id, companyId }, select: { role: true } }),
    prisma.clubUserAccess.findMany({
      where: { userId: user.id, club: { companyId } },
      select: { role: true },
    }),
  ]);
  const roles = new Set<string>([...companyRows.map((r) => r.role), ...clubRows.map((r) => r.role)]);
  // Expand implied roles (e.g. chief_accountant also grants every accountant
  // permission) so downstream page/capability checks stay centralized.
  return expandEffectiveRoles([...roles].filter(isKnownRole));
}

/**
 * Resolves the current user's effective access for the selected scope. Returns
 * null if not authenticated. Effective roles come only from company/club access
 * grants — the global User.role never grants permissions inside the app.
 */
export async function getCurrentAccessContext(): Promise<AccessContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const [scope, allowedCompanyIds] = await Promise.all([
    getCurrentCompanyAndClub(user),
    listAccessibleCompanyIds(user),
  ]);

  if (!scope.company) {
    return {
      user,
      selectedCompanyId: null,
      selectedClubId: null,
      effectiveRole: null,
      effectiveRoles: [],
      allowedCompanyIds,
      allowedClubIds: [],
    };
  }

  const effectiveRoles = await effectiveRolesInCompany(user, scope.company.id);
  return {
    user,
    selectedCompanyId: scope.company.id,
    selectedClubId: scope.club?.id ?? null,
    effectiveRole: highestRole(effectiveRoles),
    effectiveRoles,
    allowedCompanyIds,
    allowedClubIds: scope.clubIds,
  };
}

/**
 * Guard for protected (app) pages: redirects unauthenticated users to /login,
 * users without any effective access to /no-access, and users lacking access to
 * the requested page to their landing page.
 */
export async function requirePageAccess(page: AppPage): Promise<CurrentUser> {
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");
  if (!ctx.selectedCompanyId || ctx.effectiveRoles.length === 0 || !ctx.effectiveRole) {
    // No access yet -> let a brand-new user create their first company/club.
    redirect("/onboarding");
  }
  if (!canAnyRoleAccessPage(ctx.effectiveRoles, page)) {
    redirect(`/${landingPageForRole(ctx.effectiveRole)}`);
  }
  return ctx.user;
}

export async function canAccessCompany(userId: string, companyId: string): Promise<boolean> {
  const row = await prisma.companyUserAccess.findFirst({
    where: { userId, companyId },
    select: { id: true },
  });
  return row !== null;
}

export async function canAccessClub(userId: string, clubId: string): Promise<boolean> {
  const direct = await prisma.clubUserAccess.findFirst({
    where: { userId, clubId },
    select: { id: true },
  });
  if (direct) return true;

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { companyId: true },
  });
  if (!club) return false;
  return canAccessCompany(userId, club.companyId);
}

export async function userHasCompanyRole(
  userId: string,
  companyId: string,
  roles: readonly string[],
): Promise<boolean> {
  const rows = await prisma.companyUserAccess.findMany({
    where: { userId, companyId },
    select: { role: true },
  });
  return anyRoleSatisfies(rows.map((r) => r.role), roles);
}

/**
 * DIRECT role check: does the user hold `role` EXPLICITLY on this club (a
 * ClubUserAccess row) or company-wide (a CompanyUserAccess row) — WITHOUT any
 * ROLE_IMPLICATIONS expansion. Use this where an implied capability must NOT count,
 * e.g. confirming a "Директор → Клуб" cash transfer requires a real club manager,
 * so a regional_director (who is implied-manager via ROLE_IMPLICATIONS) is rejected.
 */
export async function userHasDirectClubRole(
  userId: string,
  clubId: string,
  role: string,
): Promise<boolean> {
  const clubRow = await prisma.clubUserAccess.findFirst({
    where: { userId, clubId, role },
    select: { id: true },
  });
  if (clubRow) return true;
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!club) return false;
  const companyRow = await prisma.companyUserAccess.findFirst({
    where: { userId, companyId: club.companyId, role },
    select: { id: true },
  });
  return companyRow !== null;
}

export async function userHasClubRole(
  userId: string,
  clubId: string,
  roles: readonly string[],
): Promise<boolean> {
  const clubRows = await prisma.clubUserAccess.findMany({
    where: { userId, clubId },
    select: { role: true },
  });
  if (anyRoleSatisfies(clubRows.map((r) => r.role), roles)) return true;

  // Company-level roles also satisfy club-level checks for clubs in that company.
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { companyId: true },
  });
  if (!club) return false;
  const companyRows = await prisma.companyUserAccess.findMany({
    where: { userId, companyId: club.companyId },
    select: { role: true },
  });
  return anyRoleSatisfies(companyRows.map((r) => r.role), roles);
}

// --- Operational approver resolution (invoices / refunds) ------------------
// Single source of truth for "who is the expected approver of this club's
// invoices/refunds". An ACTIVE assigned Regional Director takes precedence;
// otherwise the Chief Accountant approves as a fallback. Reuses the access
// models — never duplicated in the invoice/refund modules.

export type OperationalApproverRole = "regional_director" | "chief_accountant";

/**
 * True if the club has at least one ACTIVE Regional Director with valid access:
 * a club-level regional_director assignment, OR a company-level regional_director
 * (which covers every club in the company). Inactive users, other companies and
 * non-regional roles never count. Drives the Chief Accountant fallback.
 */
export async function hasActiveRegionalApproverForClub(companyId: string, clubId: string): Promise<boolean> {
  const [clubRows, companyRows] = await Promise.all([
    prisma.clubUserAccess.findMany({
      where: { clubId, role: "regional_director", user: { isActive: true } },
      select: { id: true },
      take: 1,
    }),
    prisma.companyUserAccess.findMany({
      where: { companyId, role: "regional_director", user: { isActive: true } },
      select: { id: true },
      take: 1,
    }),
  ]);
  return clubRows.length > 0 || companyRows.length > 0;
}

/** Expected approver for a club's invoices/refunds (regional if an active one is
 * assigned, otherwise chief accountant). Derived from live access, never stored. */
export async function getOperationalApproverForClub(
  companyId: string,
  clubId: string,
): Promise<OperationalApproverRole> {
  return (await hasActiveRegionalApproverForClub(companyId, clubId)) ? "regional_director" : "chief_accountant";
}

// --- User-management authorization (rules 1–9) ----------------------------
// Owner manages all users in their company; a regional director may manage
// managers for assigned clubs. Managers and accountants cannot invite users.

export function canManageCompanyUsers(userId: string, companyId: string): Promise<boolean> {
  // General director is the primary user-management role; owner retains it too.
  return userHasCompanyRole(userId, companyId, ["owner", "general_director"]);
}

export function canManageClubUsers(userId: string, clubId: string): Promise<boolean> {
  // owner / general director (company-level) and regional_director qualify;
  // manager / accountant / marketer do not.
  return userHasClubRole(userId, clubId, ["owner", "general_director", "regional_director"]);
}

// --- Members & invitations ------------------------------------------------

export type CompanyMember = {
  accessId: string;
  scope: "company" | "club";
  role: string;
  clubId: string | null;
  clubName: string | null;
  user: { id: string; name: string; email: string; isActive: boolean };
};

const MEMBER_USER_SELECT = {
  select: { id: true, name: true, email: true, isActive: true },
} as const;

/** All access grants (company-level and club-level) within a company. */
export async function getCompanyMembers(companyId: string): Promise<CompanyMember[]> {
  const [companyRows, clubRows] = await Promise.all([
    prisma.companyUserAccess.findMany({
      where: { companyId },
      include: { user: MEMBER_USER_SELECT },
      orderBy: { createdAt: "asc" },
    }),
    prisma.clubUserAccess.findMany({
      where: { club: { companyId } },
      include: { user: MEMBER_USER_SELECT, club: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const members: CompanyMember[] = [];
  for (const r of companyRows) {
    members.push({ accessId: r.id, scope: "company", role: r.role, clubId: null, clubName: null, user: r.user });
  }
  for (const r of clubRows) {
    members.push({ accessId: r.id, scope: "club", role: r.role, clubId: r.clubId, clubName: r.club.name, user: r.user });
  }
  return members;
}

/** Raw roles the user holds in a company (company-level + club-level), no implications. */
export async function rawRolesInCompany(userId: string, companyId: string): Promise<Set<string>> {
  const [companyRows, clubRows] = await Promise.all([
    prisma.companyUserAccess.findMany({ where: { userId, companyId }, select: { role: true } }),
    prisma.clubUserAccess.findMany({ where: { userId, club: { companyId } }, select: { role: true } }),
  ]);
  return new Set<string>([...companyRows.map((r) => r.role), ...clubRows.map((r) => r.role)]);
}

/**
 * Roles the user may invite within a company:
 *  - owner -> owner (multiple owners), and general_director ONLY if none exists yet
 *  - general_director -> regional_director, accountant, manager, marketer
 *  - regional_director -> manager only (for clubs they manage)
 *  - others -> none
 * General director replaces owner as the primary user-management role.
 */
export async function getInvitableRoles(userId: string, companyId: string): Promise<string[]> {
  const roles = await rawRolesInCompany(userId, companyId);
  const set = new Set<string>();

  if (roles.has("owner")) {
    set.add("owner");
    set.add("chief_accountant");
    const gdExists = await prisma.companyUserAccess.findFirst({
      where: { companyId, role: "general_director" },
      select: { id: true },
    });
    if (!gdExists) set.add("general_director");
  }
  if (roles.has("general_director")) {
    ["regional_director", "chief_accountant", "accountant", "manager", "marketer"].forEach((r) => set.add(r));
  }
  if (roles.has("regional_director")) {
    set.add("manager");
  }
  return [...set];
}

/** Club ids where the user may manage members (owner/GD -> all; RD -> assigned). */
export async function getManageableClubIds(userId: string, companyId: string): Promise<string[]> {
  if (await userHasCompanyRole(userId, companyId, ["owner", "general_director"])) {
    const clubs = await prisma.club.findMany({ where: { companyId }, select: { id: true } });
    return clubs.map((c) => c.id);
  }
  const rows = await prisma.clubUserAccess.findMany({
    where: { userId, role: "regional_director", club: { companyId } },
    select: { clubId: true },
  });
  return rows.map((r) => r.clubId);
}

// --- User-management authority hierarchy (Part 9) -------------------------
// Centralized authority check for administrative actions on ANOTHER user
// (session revocation, deactivation). Scope-aware: numeric rank alone is never
// enough — Company/Club scope is always required. Default-deny.

export type ManageDecision = { ok: true } | { ok: false; error: string };
const MANAGE_DENY: ManageDecision = { ok: false, error: "У вас нет прав для управления этим пользователем." };

/** True if the target user is the only active Owner of the company. */
export async function isLastActiveOwner(companyId: string, targetUserId: string): Promise<boolean> {
  const owners = await prisma.companyUserAccess.findMany({
    where: { companyId, role: "owner", user: { isActive: true } },
    select: { userId: true },
  });
  const distinct = new Set(owners.map((o) => o.userId));
  return distinct.has(targetUserId) && distinct.size <= 1;
}

/**
 * May `actorId` administratively manage `targetUserId` within `companyId`?
 *  - Owner: any member of the company (last-Owner protection handled by caller).
 *  - General Director: anyone EXCEPT Owner / another General Director.
 *  - Regional Director: only a Manager assigned to a Club within the RD's scope.
 *  - everyone else: denied.
 * Platform/superadmin targets and unknown roles are always denied. Never trusts
 * a self-action (caller also blocks self where relevant).
 */
export async function assertCanManageUser(
  actorId: string,
  targetUserId: string,
  companyId: string,
): Promise<ManageDecision> {
  if (actorId === targetUserId) {
    return { ok: false, error: "Нельзя управлять собственной учётной записью." };
  }
  if (!(await canAccessCompany(actorId, companyId)) && !(await getManageableClubIds(actorId, companyId)).length) {
    return MANAGE_DENY;
  }

  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { role: true } });
  if (target && isPlatformSuperadmin(target.role)) return MANAGE_DENY;

  const targetRoles = await rawRolesInCompany(targetUserId, companyId);
  if (targetRoles.size === 0) {
    // Do not disclose existence of users outside the actor's company.
    return MANAGE_DENY;
  }
  for (const r of targetRoles) if (!isKnownRole(r)) return MANAGE_DENY; // default-deny unknown

  if (await userHasCompanyRole(actorId, companyId, ["owner"])) return { ok: true };

  if (await userHasCompanyRole(actorId, companyId, ["general_director"])) {
    if (targetRoles.has("owner") || targetRoles.has("general_director")) return MANAGE_DENY;
    return { ok: true };
  }

  // Regional Director: managers within the RD's manageable clubs only.
  const isRD = (await prisma.clubUserAccess.findFirst({
    where: { userId: actorId, role: "regional_director", club: { companyId } },
    select: { id: true },
  })) !== null;
  if (isRD) {
    const onlyManager = [...targetRoles].every((r) => r === "manager");
    if (!onlyManager) return MANAGE_DENY;
    const manageableClubIds = await getManageableClubIds(actorId, companyId);
    const inScope = await prisma.clubUserAccess.findFirst({
      where: { userId: targetUserId, role: "manager", clubId: { in: manageableClubIds } },
      select: { id: true },
    });
    return inScope ? { ok: true } : MANAGE_DENY;
  }

  return MANAGE_DENY;
}

// --- Audit log ------------------------------------------------------------

export async function recordAudit(entry: {
  action: string;
  entityType: string;
  companyId?: string | null;
  clubId?: string | null;
  userId?: string | null;
  entityId?: string | null;
  metadata?: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      companyId: entry.companyId ?? null,
      clubId: entry.clubId ?? null,
      userId: entry.userId ?? null,
      entityId: entry.entityId ?? null,
      metadataJson: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
    },
  });
}
