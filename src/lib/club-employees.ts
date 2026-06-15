// Operational club employees (NOT system login users). Managers, administrators,
// trainers, night managers. Used for the sales-report shift-manager selection and
// the /employees roster. All queries are scope-safe (companyId + allowed clubs).
import { Prisma, type ClubEmployee } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/lib/auth";

export type EmployeePosition = "manager" | "administrator" | "gym_trainer" | "group_trainer" | "night_manager";

export const EMPLOYEE_POSITIONS: ReadonlyArray<{ key: EmployeePosition; label: string }> = [
  { key: "manager", label: "Менеджер" },
  { key: "administrator", label: "Администратор" },
  { key: "gym_trainer", label: "Тренер ТЗ" },
  { key: "group_trainer", label: "Тренер ГП" },
  { key: "night_manager", label: "Ночной менеджер" },
];
export const EMPLOYEE_POSITION_LABELS: Record<string, string> = Object.fromEntries(
  EMPLOYEE_POSITIONS.map((p) => [p.key, p.label]),
);
export const EMPLOYEE_POSITION_KEYS = new Set<string>(EMPLOYEE_POSITIONS.map((p) => p.key));
export function employeePositionLabel(position: string): string {
  return EMPLOYEE_POSITION_LABELS[position] ?? position;
}

export const EMPLOYEE_STATUS_FILTERS = [
  { key: "active", label: "Активные" },
  { key: "dismissed", label: "Уволенные" },
  { key: "all", label: "Все" },
] as const;

// Positions allowed to close a shift (sales-report manager dropdown).
export const SHIFT_MANAGER_POSITIONS: EmployeePosition[] = ["manager", "night_manager"];

/**
 * Create / dismiss employees: owner, general director, regional director and
 * manager (operational). Accountant is view-only; marketer has no access.
 */
export function canManageEmployees(roles: readonly Role[]): boolean {
  return roles.some((r) => r === "owner" || r === "general_director" || r === "regional_director" || r === "manager");
}

export type ClubEmployeeRow = ClubEmployee & { clubName: string };

/** Roster for the scope, optionally filtered by club / position / status. */
export async function getEmployeesForScope(
  companyId: string,
  clubIds: string[],
  filters?: { clubId?: string; position?: string; status?: string },
): Promise<ClubEmployeeRow[]> {
  if (clubIds.length === 0) return [];
  // Never trust a club param beyond the user's accessible clubs.
  const clubFilter = filters?.clubId && clubIds.includes(filters.clubId) ? [filters.clubId] : clubIds;
  const where: Prisma.ClubEmployeeWhereInput = { companyId, clubId: { in: clubFilter } };
  if (filters?.position && EMPLOYEE_POSITION_KEYS.has(filters.position)) where.position = filters.position;
  if (filters?.status === "active" || filters?.status === "dismissed") where.status = filters.status;
  const rows = await prisma.clubEmployee.findMany({
    where,
    orderBy: [{ status: "asc" }, { fullName: "asc" }],
    include: { club: { select: { name: true } } },
  });
  return rows.map((r) => ({ ...r, clubName: r.club.name }));
}

export type ManagerCandidate = { id: string; fullName: string; position: string; clubId: string };

/** Active manager / night-manager employees for the sales-report dropdown. */
export async function getActiveManagerCandidates(companyId: string, clubIds: string[]): Promise<ManagerCandidate[]> {
  if (clubIds.length === 0) return [];
  return prisma.clubEmployee.findMany({
    where: { companyId, clubId: { in: clubIds }, status: "active", position: { in: SHIFT_MANAGER_POSITIONS } },
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true, position: true, clubId: true },
  });
}

/** Single employee scoped to company + the caller's accessible clubs. */
export async function getEmployeeForScope(
  companyId: string,
  accessibleClubIds: string[],
  id: string,
): Promise<ClubEmployee | null> {
  const e = await prisma.clubEmployee.findUnique({ where: { id } });
  if (!e || e.companyId !== companyId || !accessibleClubIds.includes(e.clubId)) return null;
  return e;
}
