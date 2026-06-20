"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";
import {
  assertLegalEntityAvailableForClub,
  type LegalEntityType,
  type LegalEntityCheck,
} from "@/lib/legal-entities";
import { lockCompanyRow } from "@/lib/db-locking";

// Not exported (a "use server" module may only export async functions).
type State = { ok: boolean; error?: string; needsConfirm?: boolean; warning?: string };

// Collapse runs of whitespace and trim — keeps Cyrillic intact, removes only
// accidental double spaces / leading-trailing padding. Preserves display form.
function normalizeText(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

// Case-insensitive comparison key for duplicate detection (Cyrillic-safe; no
// transliteration). Comparison only — never stored or displayed.
function normalizeKey(v: string): string {
  return normalizeText(v).toLocaleLowerCase("ru-RU");
}

// Sentinel for an in-transaction duplicate so the create rolls back cleanly.
const DUPLICATE_CLUB = "DUPLICATE_CLUB";

// Map a centralized LegalEntity validation failure to a safe Russian message.
function legalEntityErrorMessage(check: Exclude<LegalEntityCheck, { ok: true }>, field: "ООО" | "ИП"): string {
  switch (check.reason) {
    case "not_found":
      return `Выбранное ${field} не найдено`;
    case "wrong_company":
      return `${field} принадлежит другой организации`;
    case "inactive":
      return `Выбранное ${field} неактивно и не может быть назначено`;
    case "wrong_type":
      return `Выбранное юрлицо не является ${field}`;
  }
}

async function requireOwnerOf(companyId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "settings")) {
    return { error: "Нет доступа" as const };
  }
  if (!ctx.allowedCompanyIds.includes(companyId) || !(await userHasCompanyRole(ctx.user.id, companyId, ["owner"]))) {
    return { error: "Только владелец организации может это изменить" as const };
  }
  return { ctx };
}

export async function createCompany(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "settings")) {
    return { ok: false, error: "Нет доступа" };
  }
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название организации" };

  // New company -> the creator becomes its owner.
  const company = await prisma.$transaction(async (tx) => {
    const c = await tx.company.create({ data: { name } });
    await tx.companyUserAccess.create({
      data: { companyId: c.id, userId: ctx.user.id, role: "owner" },
    });
    return c;
  });

  await recordAudit({
    action: "company.created",
    entityType: "Company",
    entityId: company.id,
    companyId: company.id,
    userId: ctx.user.id,
    metadata: { name },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function updateCompany(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const companyId = String(formData.get("companyId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название организации" };

  const guard = await requireOwnerOf(companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  await prisma.company.update({ where: { id: companyId }, data: { name } });
  await recordAudit({
    action: "company.updated",
    entityType: "Company",
    entityId: companyId,
    companyId,
    userId: guard.ctx.user.id,
    metadata: { name },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function createClub(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const companyId = String(formData.get("companyId") ?? "").trim();
  const name = normalizeText(String(formData.get("name") ?? ""));
  const city = normalizeText(String(formData.get("city") ?? ""));
  // Optional active legal-entity assignments (Не назначено = empty).
  const oooId = String(formData.get("oooId") ?? "").trim();
  const ipId = String(formData.get("ipId") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название клуба" };
  if (!city) return { ok: false, error: "Укажите город" };

  // Owner-only structural administration (Part 3). Owner being operationally
  // read-only does not block structural Company administration.
  const guard = await requireOwnerOf(companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  // Revalidate the selected ООО / ИП server-side (Part 5 steps 2-3). IDs from
  // FormData are never trusted: each must belong to THIS Company, be active and
  // be of the matching type.
  const checks: Array<{ id: string; type: LegalEntityType; field: "ООО" | "ИП" }> = [];
  if (oooId) checks.push({ id: oooId, type: "ooo", field: "ООО" });
  if (ipId) checks.push({ id: ipId, type: "ip", field: "ИП" });
  for (const c of checks) {
    const res = await assertLegalEntityAvailableForClub(companyId, c.id, c.type);
    if (!res.ok) return { ok: false, error: legalEntityErrorMessage(res, c.field) };
  }

  // Duplicate identity = same Company + normalized City + normalized name
  // (case-insensitive, Cyrillic-safe). Archived clubs DO count (preferred
  // policy: restore instead of recreating). The check runs INSIDE the
  // transaction AFTER a Company row lock so two concurrent same-identity
  // creates cannot both pass (Part 6, option A). Atomic: club + owner
  // club-access + active ООО/ИП associations are all-or-nothing.
  const nameKey = normalizeKey(name);
  const cityKey = normalizeKey(city);
  let club;
  try {
    club = await prisma.$transaction(async (tx) => {
      await lockCompanyRow(tx, companyId);
      const siblings = await tx.club.findMany({
        where: { companyId },
        select: { name: true, city: true },
      });
      const dup = siblings.some(
        (s) => normalizeKey(s.name) === nameKey && normalizeKey(s.city) === cityKey,
      );
      if (dup) throw new Error(DUPLICATE_CLUB);

      const c = await tx.club.create({ data: { name, city, companyId } });
      await tx.clubUserAccess.create({
        data: { clubId: c.id, userId: guard.ctx.user.id, role: "owner" },
      });
      for (const ce of checks) {
        await tx.clubLegalEntity.create({
          data: { clubId: c.id, legalEntityId: ce.id, isPrimary: true, isActive: true },
        });
      }
      return c;
    });
  } catch (e) {
    if (e instanceof Error && e.message === DUPLICATE_CLUB) {
      return { ok: false, error: "Клуб с таким названием уже есть в этом городе и сети" };
    }
    return { ok: false, error: "Не удалось создать клуб. Повторите попытку." };
  }

  await recordAudit({
    action: "club.created",
    entityType: "Club",
    entityId: club.id,
    companyId,
    clubId: club.id,
    userId: guard.ctx.user.id,
    metadata: { name, city },
  });
  for (const ce of checks) {
    await recordAudit({
      action: "club.legal_entity_assigned",
      entityType: "ClubLegalEntity",
      entityId: club.id,
      companyId,
      clubId: club.id,
      userId: guard.ctx.user.id,
      metadata: { legalEntityId: ce.id, legalEntityType: ce.type, city },
    });
  }

  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function updateClub(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const clubId = String(formData.get("clubId") ?? "").trim();
  const name = normalizeText(String(formData.get("name") ?? ""));
  const city = normalizeText(String(formData.get("city") ?? ""));
  if (!name) return { ok: false, error: "Укажите название клуба" };

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!club) return { ok: false, error: "Клуб не найден" };

  const guard = await requireOwnerOf(club.companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  await prisma.club.update({ where: { id: clubId }, data: { name, city: city || "—" } });
  await recordAudit({
    action: "club.updated",
    entityType: "Club",
    entityId: clubId,
    companyId: club.companyId,
    clubId,
    userId: guard.ctx.user.id,
    metadata: { name, city: city || "—" },
  });

  revalidatePath("/settings");
  return { ok: true };
}

export async function archiveClub(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const clubId = String(formData.get("clubId") ?? "").trim();
  const confirmed = String(formData.get("confirm") ?? "") === "true";

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { companyId: true, isActive: true, name: true },
  });
  if (!club) return { ok: false, error: "Клуб не найден" };

  const guard = await requireOwnerOf(club.companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  if (!club.isActive) return { ok: false, error: "Клуб уже в архиве" };

  // Guard against archiving the last active club without an explicit confirm.
  const activeCount = await prisma.club.count({
    where: { companyId: club.companyId, isActive: true },
  });
  if (activeCount <= 1 && !confirmed) {
    return {
      ok: false,
      needsConfirm: true,
      error: "Это последний активный клуб организации. Подтвердите архивацию.",
    };
  }

  await prisma.club.update({
    where: { id: clubId },
    data: { isActive: false, archivedAt: new Date() },
  });
  await recordAudit({
    action: "club.archived",
    entityType: "Club",
    entityId: clubId,
    companyId: club.companyId,
    clubId,
    userId: guard.ctx.user.id,
    metadata: { name: club.name, lastActive: activeCount <= 1 },
  });

  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function restoreClub(
  _prev: State | undefined,
  formData: FormData,
): Promise<State> {
  const clubId = String(formData.get("clubId") ?? "").trim();

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { companyId: true, isActive: true, name: true },
  });
  if (!club) return { ok: false, error: "Клуб не найден" };

  const guard = await requireOwnerOf(club.companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  if (club.isActive) return { ok: false, error: "Клуб уже активен" };

  await prisma.club.update({
    where: { id: clubId },
    data: { isActive: true, archivedAt: null },
  });

  // Part 9: revalidate prior active assignments. If a previously linked entity
  // is now globally inactive, surface that reassignment is required — never
  // silently swap in another entity.
  const staleLinks = await prisma.clubLegalEntity.findMany({
    where: { clubId, isActive: true, legalEntity: { isActive: false } },
    select: { legalEntity: { select: { name: true, type: true } } },
  });

  await recordAudit({
    action: "club.restored",
    entityType: "Club",
    entityId: clubId,
    companyId: club.companyId,
    clubId,
    userId: guard.ctx.user.id,
    metadata: { name: club.name, staleAssignments: staleLinks.length },
  });

  revalidatePath("/settings");
  revalidatePath("/", "layout");
  if (staleLinks.length > 0) {
    const list = staleLinks.map((l) => `${l.legalEntity.type === "ip" || l.legalEntity.type === "ИП" ? "ИП" : "ООО"} «${l.legalEntity.name}»`).join(", ");
    return { ok: true, warning: `Клуб восстановлен. Требуется переназначить неактивное юрлицо: ${list}.` };
  }
  return { ok: true };
}
