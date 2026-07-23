// Employee ↔ club assignments (many-to-many). An employee can work at several clubs,
// each with a position and an optional earning-share (доля начисления, basis points).
// Scalar-id table (no Prisma relations) — ownership is validated in server code.
import type { EmployeeClubAssignment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PAYROLL_POSITIONS, isKnown } from "@/lib/payroll/enums";

export type AssignmentDraft = {
  clubId: string;
  position: string;
  earningShareBasisPoints: number | null;
};

export type ValidateAssignmentResult = { ok: true; value: AssignmentDraft } | { ok: false; error: string };

/**
 * Validate a raw assignment draft. Pure — no DB. Position must be a known payroll
 * position; the earning share (if given) is an integer 0..10000 bp (0–100%).
 */
export function validateAssignmentDraft(raw: {
  clubId: string;
  position: string;
  earningShareBasisPoints?: number | null;
}): ValidateAssignmentResult {
  const clubId = (raw.clubId ?? "").trim();
  const position = (raw.position ?? "").trim();
  if (!clubId) return { ok: false, error: "Выберите клуб." };
  if (!isKnown(PAYROLL_POSITIONS, position)) return { ok: false, error: "Выберите должность." };
  let share: number | null = null;
  if (raw.earningShareBasisPoints != null) {
    const s = raw.earningShareBasisPoints;
    if (!Number.isInteger(s) || s < 0 || s > 10000) {
      return { ok: false, error: "Доля начисления должна быть от 0 до 100%." };
    }
    share = s;
  }
  return { ok: true, value: { clubId, position, earningShareBasisPoints: share } };
}

/** Active assignments for a set of employees, grouped by employeeId. Scope-safe caller. */
export async function getAssignmentsForEmployees(
  companyId: string,
  employeeIds: string[],
): Promise<Map<string, EmployeeClubAssignment[]>> {
  const map = new Map<string, EmployeeClubAssignment[]>();
  if (employeeIds.length === 0) return map;
  const rows = await prisma.employeeClubAssignment.findMany({
    where: { companyId, employeeId: { in: employeeIds }, isActive: true },
    orderBy: [{ position: "asc" }],
  });
  for (const r of rows) {
    const list = map.get(r.employeeId) ?? [];
    list.push(r);
    map.set(r.employeeId, list);
  }
  return map;
}

/** All active assignments for one employee. */
export async function getAssignmentsForEmployee(
  companyId: string,
  employeeId: string,
): Promise<EmployeeClubAssignment[]> {
  return prisma.employeeClubAssignment.findMany({
    where: { companyId, employeeId, isActive: true },
    orderBy: [{ position: "asc" }],
  });
}
