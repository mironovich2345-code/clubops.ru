"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, getUserClubs, recordAudit } from "@/lib/access";
import {
  canManageEmployees,
  EMPLOYEE_POSITION_KEYS,
  getEmployeeForScope,
} from "@/lib/club-employees";

export type EmployeeFormState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<"fullName" | "position" | "clubId", string>>;
};

async function accessibleClubIds(userId: string, companyId: string): Promise<string[]> {
  const clubs = await getUserClubs(userId, companyId);
  return clubs.map((c) => c.id);
}

/**
 * Create a club employee (operational record — NOT a system login user).
 * Owner / GD / regional / manager only, scoped to accessible clubs.
 */
export async function createClubEmployee(
  _prev: EmployeeFormState | undefined,
  formData: FormData,
): Promise<EmployeeFormState> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа" };
  if (!canManageEmployees(ctx.effectiveRoles)) {
    return { ok: false, error: "Недостаточно прав для добавления сотрудников" };
  }
  const companyId = ctx.selectedCompanyId;
  const clubIds = await accessibleClubIds(ctx.user.id, companyId);

  const clubId = String(formData.get("clubId") ?? "").trim();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const position = String(formData.get("position") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim() || null;

  const fieldErrors: EmployeeFormState["fieldErrors"] = {};
  if (!fullName) fieldErrors.fullName = "Укажите ФИО";
  if (!position || !EMPLOYEE_POSITION_KEYS.has(position)) fieldErrors.position = "Выберите должность";
  if (!clubId) fieldErrors.clubId = "Выберите клуб";
  else if (!clubIds.includes(clubId)) fieldErrors.clubId = "Нет доступа к выбранному клубу";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  // Soft duplicate guard: same active person at the same position + club.
  const dup = await prisma.clubEmployee.findFirst({
    where: { companyId, clubId, position, status: "active", fullName: { equals: fullName } },
    select: { id: true },
  });
  if (dup) {
    return { ok: false, error: "Активный сотрудник с таким ФИО и должностью уже есть в этом клубе" };
  }

  const employee = await prisma.clubEmployee.create({
    data: { companyId, clubId, fullName, position, comment, status: "active" },
  });
  await recordAudit({
    action: "employee.created",
    entityType: "ClubEmployee",
    entityId: employee.id,
    companyId,
    clubId,
    userId: ctx.user.id,
    metadata: { position },
  });

  revalidatePath("/employees");
  revalidatePath("/sales");
  return { ok: true };
}

/** Mark an employee dismissed (status=dismissed, dismissedAt=now). No hard delete. */
export async function dismissClubEmployee(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId || !canManageEmployees(ctx.effectiveRoles)) return;
  const companyId = ctx.selectedCompanyId;
  const clubIds = await accessibleClubIds(ctx.user.id, companyId);

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const employee = await getEmployeeForScope(companyId, clubIds, id);
  if (!employee || employee.status === "dismissed") return;

  await prisma.clubEmployee.update({
    where: { id: employee.id },
    data: { status: "dismissed", dismissedAt: new Date() },
  });
  await recordAudit({
    action: "employee.dismissed",
    entityType: "ClubEmployee",
    entityId: employee.id,
    companyId,
    clubId: employee.clubId,
    userId: ctx.user.id,
  });

  revalidatePath("/employees");
  revalidatePath("/sales");
}
