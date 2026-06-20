"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";
import {
  isEntityType,
  normalizeEntityType,
  legalEntityTypeLabel,
  findClubActiveEntityOfType,
  assertLegalEntityAvailableForClub,
  type LegalEntityType,
} from "@/lib/legal-entities";

type State = { ok: boolean; error?: string };

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

// Entity PROFILE management (create/edit/global active) — owner or GD.
const MANAGER_ROLES = ["owner", "general_director"] as const;
// Club↔entity ASSIGNMENT (attach/detach/replace) is structural Club admin —
// owner only (Part 3: GD is read-only for Club structure).
const OWNER_ROLES = ["owner"] as const;

async function requireManager(companyId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "settings")) {
    return { error: "Нет доступа" as const };
  }
  if (!ctx.allowedCompanyIds.includes(companyId)) return { error: "Нет доступа к компании" as const };
  if (!(await userHasCompanyRole(ctx.user.id, companyId, MANAGER_ROLES))) {
    return { error: "Управлять юрлицами может владелец или ген. директор" as const };
  }
  return { ctx };
}

async function requireOwner(companyId: string) {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !canAnyRoleAccessPage(ctx.effectiveRoles, "settings")) {
    return { error: "Нет доступа" as const };
  }
  if (!ctx.allowedCompanyIds.includes(companyId)) return { error: "Нет доступа к компании" as const };
  if (!(await userHasCompanyRole(ctx.user.id, companyId, OWNER_ROLES))) {
    return { error: "Назначать юрлица клубу может только владелец организации" as const };
  }
  return { ctx };
}

export async function createLegalEntity(_prev: State | undefined, formData: FormData): Promise<State> {
  const companyId = String(formData.get("companyId") ?? "").trim();
  const guard = await requireManager(companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  const name = str(formData, "name");
  const type = String(formData.get("type") ?? "").trim();
  if (!name) return { ok: false, error: "Укажите название юрлица" };
  if (!isEntityType(type)) return { ok: false, error: "Выберите тип (ООО или ИП)" };

  const entity = await prisma.legalEntity.create({
    data: { companyId, type, ...profileFields(formData, name) },
  });
  await recordAudit({
    action: "legal_entity.created",
    entityType: "LegalEntity",
    entityId: entity.id,
    companyId,
    userId: guard.ctx.user.id,
    metadata: { name, type },
  });
  revalidatePath("/settings");
  return { ok: true };
}

// Full profile (name is required and already validated by the caller).
function profileFields(formData: FormData, name: string) {
  return {
    name,
    fullName: str(formData, "fullName"),
    shortName: str(formData, "shortName"),
    inn: str(formData, "inn"),
    kpp: str(formData, "kpp"),
    ogrn: str(formData, "ogrn"),
    legalAddress: str(formData, "legalAddress"),
    phone: str(formData, "phone"),
    email: str(formData, "email"),
    bankName: str(formData, "bankName"),
    bankBik: str(formData, "bankBik"),
    accountNumber: str(formData, "accountNumber"),
    corrAccount: str(formData, "corrAccount"),
    directorName: str(formData, "directorName"),
    comment: str(formData, "comment"),
  };
}

export async function updateLegalEntity(_prev: State | undefined, formData: FormData): Promise<State> {
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  const existing = await prisma.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!existing) return { ok: false, error: "Юрлицо не найдено" };
  const guard = await requireManager(existing.companyId);
  if ("error" in guard) return { ok: false, error: guard.error };

  const name = str(formData, "name");
  if (!name) return { ok: false, error: "Укажите название юрлица" };

  const next = profileFields(formData, name);
  const changedFields = (Object.keys(next) as (keyof typeof next)[]).filter(
    (k) => (existing[k] ?? null) !== next[k],
  );

  await prisma.legalEntity.update({ where: { id: legalEntityId }, data: next });
  await recordAudit({
    action: "legal_entity.updated",
    entityType: "LegalEntity",
    entityId: legalEntityId,
    companyId: existing.companyId,
    userId: guard.ctx.user.id,
    metadata: { changedFields },
  });
  revalidatePath("/settings");
  return { ok: true };
}

export async function setLegalEntityActive(formData: FormData): Promise<void> {
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "true";
  const existing = await prisma.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!existing) throw new Error("Юрлицо не найдено");
  const guard = await requireManager(existing.companyId);
  if ("error" in guard) throw new Error(guard.error);

  // Rule: max 1 active ООО + 1 active ИП per club. Activating must not create a
  // second active entity of the same type on any club this entity is attached to.
  if (active) {
    const type = normalizeEntityType(existing.type);
    if (type) {
      const links = await prisma.clubLegalEntity.findMany({ where: { legalEntityId }, select: { clubId: true } });
      for (const { clubId } of links) {
        const conflict = await findClubActiveEntityOfType(clubId, type, legalEntityId);
        if (conflict) {
          throw new Error(`У клуба уже есть активное ${legalEntityTypeLabel(existing.type)}: «${conflict.name}». Допустимо одно активное ООО и одно активное ИП на клуб.`);
        }
      }
    }
  }

  await prisma.legalEntity.update({ where: { id: legalEntityId }, data: { isActive: active } });
  await recordAudit({
    action: active ? "legal_entity.activated" : "legal_entity.deactivated",
    entityType: "LegalEntity",
    entityId: legalEntityId,
    companyId: existing.companyId,
    userId: guard.ctx.user.id,
  });
  revalidatePath("/settings");
}

export async function attachLegalEntityToClub(formData: FormData): Promise<void> {
  const clubId = String(formData.get("clubId") ?? "").trim();
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  const entity = await prisma.legalEntity.findUnique({ where: { id: legalEntityId } });
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true, isActive: true } });
  if (!entity || !club) throw new Error("Не найдено");
  if (entity.companyId !== club.companyId) throw new Error("Юрлицо из другой компании");
  const guard = await requireOwner(entity.companyId);
  if ("error" in guard) throw new Error(guard.error);
  if (!club.isActive) throw new Error("Клуб в архиве — назначение юрлица недоступно");
  if (!entity.isActive) throw new Error("Юрлицо неактивно и не может быть назначено");
  const type = normalizeEntityType(entity.type);
  if (!type) throw new Error("Некорректный тип юрлица");

  // Rule: max 1 active ООО + 1 active ИП per club. An active entity may not be
  // attached to a club that already has a DIFFERENT active entity of the same
  // type (use "Заменить" to swap intentionally).
  const conflict = await findClubActiveEntityOfType(clubId, type, legalEntityId);
  if (conflict) {
    await recordAudit({
      action: "club.legal_entity_assignment_blocked",
      entityType: "ClubLegalEntity", entityId: clubId, companyId: entity.companyId, clubId, userId: guard.ctx.user.id,
      metadata: { legalEntityId, legalEntityType: type, reason: "active_type_conflict", conflictLegalEntityId: conflict.id },
    });
    throw new Error(`У клуба уже есть активное ${legalEntityTypeLabel(entity.type)}: «${conflict.name}». Допустимо одно активное ООО и одно активное ИП на клуб.`);
  }

  // History-aware: a soft-closed association for the same pair is reactivated
  // (never duplicated — @@unique([clubId, legalEntityId])).
  await prisma.clubLegalEntity.upsert({
    where: { clubId_legalEntityId: { clubId, legalEntityId } },
    create: { clubId, legalEntityId, isPrimary: true, isActive: true },
    update: { isActive: true, deactivatedAt: null, isPrimary: true },
  });
  await recordAudit({
    action: "club.legal_entity_assigned",
    entityType: "ClubLegalEntity",
    entityId: clubId,
    companyId: entity.companyId,
    clubId,
    userId: guard.ctx.user.id,
    metadata: { legalEntityId, legalEntityType: type },
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
}

export async function detachLegalEntityFromClub(formData: FormData): Promise<void> {
  const clubId = String(formData.get("clubId") ?? "").trim();
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  const entity = await prisma.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!entity) throw new Error("Юрлицо не найдено");
  const guard = await requireOwner(entity.companyId);
  if ("error" in guard) throw new Error(guard.error);

  // Soft-close: preserve truthful history instead of deleting the association.
  await prisma.clubLegalEntity.updateMany({
    where: { clubId, legalEntityId, isActive: true },
    data: { isActive: false, isPrimary: false, deactivatedAt: new Date() },
  });
  await recordAudit({
    action: "legal_entity.detached",
    entityType: "ClubLegalEntity",
    entityId: legalEntityId,
    companyId: entity.companyId,
    clubId,
    userId: guard.ctx.user.id,
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
}

/**
 * Replace (or clear) the active ООО or ИП of a club, preserving history.
 * Owner-only. Validates the new entity belongs to the Company, is active and of
 * the matching type; soft-closes the previous active association of that type
 * and activates the new one — atomically. Changing ООО never touches ИП and
 * vice-versa. An empty newLegalEntityId clears the active assignment of `type`.
 */
export async function replaceClubLegalEntity(_prev: State | undefined, formData: FormData): Promise<State> {
  const clubId = String(formData.get("clubId") ?? "").trim();
  const rawType = String(formData.get("type") ?? "").trim();
  const newLegalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  const type = normalizeEntityType(rawType) as LegalEntityType | null;
  if (!type) return { ok: false, error: "Некорректный тип юрлица" };

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true, isActive: true } });
  if (!club) return { ok: false, error: "Клуб не найден" };
  const guard = await requireOwner(club.companyId);
  if ("error" in guard) return { ok: false, error: guard.error };
  if (!club.isActive) return { ok: false, error: "Клуб в архиве — изменение юрлица недоступно" };

  const fieldLabel = type === "ooo" ? "ООО" : "ИП";

  // Validate the new entity (skip when clearing the assignment).
  if (newLegalEntityId) {
    const res = await assertLegalEntityAvailableForClub(club.companyId, newLegalEntityId, type);
    if (!res.ok) {
      await recordAudit({
        action: "club.legal_entity_assignment_blocked",
        entityType: "ClubLegalEntity", entityId: clubId, companyId: club.companyId, clubId, userId: guard.ctx.user.id,
        metadata: { legalEntityId: newLegalEntityId, legalEntityType: type, reason: res.reason },
      });
      return {
        ok: false,
        error:
          res.reason === "not_found" ? `Выбранное ${fieldLabel} не найдено`
          : res.reason === "wrong_company" ? `${fieldLabel} принадлежит другой организации`
          : res.reason === "inactive" ? `Выбранное ${fieldLabel} неактивно`
          : `Выбранное юрлицо не является ${fieldLabel}`,
      };
    }
  }

  const previous = await findClubActiveEntityOfType(clubId, type);
  const previousId = previous?.id ?? null;
  if (previousId === (newLegalEntityId || null)) {
    return { ok: true }; // already in the requested state — no-op
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Soft-close the current active association(s) of this type only.
      if (previousId) {
        await tx.clubLegalEntity.updateMany({
          where: { clubId, legalEntityId: previousId, isActive: true },
          data: { isActive: false, isPrimary: false, deactivatedAt: new Date() },
        });
      }
      if (newLegalEntityId) {
        await tx.clubLegalEntity.upsert({
          where: { clubId_legalEntityId: { clubId, legalEntityId: newLegalEntityId } },
          create: { clubId, legalEntityId: newLegalEntityId, isPrimary: true, isActive: true },
          update: { isActive: true, deactivatedAt: null, isPrimary: true },
        });
      }
      // Defensive invariant check inside the tx: at most one active of this type.
      const activeOfType = await tx.clubLegalEntity.findMany({
        where: { clubId, isActive: true, legalEntity: { type: { in: type === "ooo" ? ["ooo", "ООО"] : ["ip", "ИП"] } } },
        select: { id: true },
      });
      if (activeOfType.length > 1) {
        throw new Error("CONFLICT_ACTIVE_TYPE");
      }
    });
  } catch (e) {
    const msg = e instanceof Error && e.message === "CONFLICT_ACTIVE_TYPE"
      ? `У клуба уже есть активное ${fieldLabel}. Обновите страницу и повторите.`
      : "Не удалось изменить юрлицо. Повторите попытку.";
    await recordAudit({
      action: "club.legal_entity_assignment_blocked",
      entityType: "ClubLegalEntity", entityId: clubId, companyId: club.companyId, clubId, userId: guard.ctx.user.id,
      metadata: { legalEntityId: newLegalEntityId || null, legalEntityType: type, reason: "transaction_conflict" },
    });
    return { ok: false, error: msg };
  }

  await recordAudit({
    action: "club.legal_entity_replaced",
    entityType: "ClubLegalEntity",
    entityId: clubId,
    companyId: club.companyId,
    clubId,
    userId: guard.ctx.user.id,
    metadata: { legalEntityType: type, previousLegalEntityId: previousId, newLegalEntityId: newLegalEntityId || null },
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}
