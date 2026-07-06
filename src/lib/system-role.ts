// Global platform role, separate from every Company/Club role. SQLite has no
// enums, so it is stored as TEXT on User.systemRole; the ONLY valid value is
// "system_admin". Everything is fail-closed: an unknown/typo value is NOT an
// admin. system_admin is granted only via the server-only CLI, never through
// tenant role selectors, and it does not by itself grant Company financial data.
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export const SYSTEM_ADMIN = "system_admin";
export const SYSTEM_ROLES = [SYSTEM_ADMIN] as const;

export function isSystemAdminRole(role: string | null | undefined): boolean {
  return role === SYSTEM_ADMIN; // exact match — unknown values fail closed
}

export function isValidSystemRole(role: string): boolean {
  return (SYSTEM_ROLES as readonly string[]).includes(role);
}

/**
 * The current request's user IF they are an ACTIVE, non-deleted system_admin,
 * resolved fresh from the DB (systemRole is not carried in the session/cookie).
 * Returns null otherwise. Fail-closed.
 */
export async function getCurrentSystemAdmin(): Promise<{ id: string; email: string; name: string } | null> {
  const current = await getCurrentUser();
  if (!current) return null;
  const row = await prisma.user.findUnique({
    where: { id: current.id },
    select: { id: true, email: true, name: true, systemRole: true, isActive: true, deletedAt: true },
  });
  if (!row || !row.isActive || row.deletedAt || !isSystemAdminRole(row.systemRole)) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export async function isCurrentUserSystemAdmin(): Promise<boolean> {
  return (await getCurrentSystemAdmin()) !== null;
}
