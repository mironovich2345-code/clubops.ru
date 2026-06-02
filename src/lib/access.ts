import { prisma } from "@/lib/prisma";

// Company-scoped and club-scoped access live in CompanyUserAccess / ClubUserAccess.
// The legacy global User.role and UserClubAccess remain in place so existing
// modules keep working; this layer is the future-proof, company-isolated model.

export const COMPANY_ROLES = [
  "owner",
  "regional_director",
  "manager",
  "accountant",
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

// Role hierarchy — higher roles satisfy lower-role checks.
// Rule 6: a regional director keeps manager functionality.
const ROLE_IMPLICATIONS: Record<string, readonly string[]> = {
  owner: ["owner", "regional_director", "manager", "accountant"],
  regional_director: ["regional_director", "manager"],
  manager: ["manager"],
  accountant: ["accountant"],
};

function roleSatisfies(held: string, required: string): boolean {
  return (ROLE_IMPLICATIONS[held] ?? [held]).includes(required);
}

function anyRoleSatisfies(held: string[], required: readonly string[]): boolean {
  return held.some((h) => required.some((r) => roleSatisfies(h, r)));
}

/** Distinct companies the user has any access to. */
export async function getUserCompanies(userId: string) {
  const rows = await prisma.companyUserAccess.findMany({
    where: { userId },
    include: { company: true },
    orderBy: { company: { name: "asc" } },
  });
  const byId = new Map<string, (typeof rows)[number]["company"]>();
  for (const row of rows) byId.set(row.companyId, row.company);
  return [...byId.values()];
}

/**
 * Clubs the user can access, optionally scoped to one company.
 * Access = company-level access (covers every club in that company)
 *          OR an explicit club-level role.
 */
export async function getUserClubs(userId: string, companyId?: string) {
  const [companyAccess, clubAccess] = await Promise.all([
    prisma.companyUserAccess.findMany({ where: { userId }, select: { companyId: true } }),
    prisma.clubUserAccess.findMany({ where: { userId }, select: { clubId: true } }),
  ]);

  const companyIds = [...new Set(companyAccess.map((a) => a.companyId))];
  const clubIds = [...new Set(clubAccess.map((a) => a.clubId))];

  const accessible = {
    OR: [{ companyId: { in: companyIds } }, { id: { in: clubIds } }],
  };
  const where = companyId ? { AND: [{ companyId }, accessible] } : accessible;

  return prisma.club.findMany({
    where,
    orderBy: { name: "asc" },
    include: { company: true },
  });
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

// --- User-management authorization (rules 1–9) ----------------------------
// Owner manages all users in their company; a regional director may manage
// managers for assigned clubs. Managers and accountants cannot invite users.

export function canManageCompanyUsers(userId: string, companyId: string): Promise<boolean> {
  return userHasCompanyRole(userId, companyId, ["owner"]);
}

export function canManageClubUsers(userId: string, clubId: string): Promise<boolean> {
  // owner (via company role) and regional_director qualify; manager/accountant do not.
  return userHasClubRole(userId, clubId, ["regional_director"]);
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
