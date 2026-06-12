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
} from "@/lib/legal-entities";

type State = { ok: boolean; error?: string };

function str(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

const MANAGER_ROLES = ["owner", "general_director"] as const;

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
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  if (!entity || !club) throw new Error("Не найдено");
  if (entity.companyId !== club.companyId) throw new Error("Юрлицо из другой компании");
  const guard = await requireManager(entity.companyId);
  if ("error" in guard) throw new Error(guard.error);

  // Rule: max 1 active ООО + 1 active ИП per club. An active entity may not be
  // attached to a club that already has a different active entity of the same
  // type. (Inactive entities don't conflict — activation is guarded separately.)
  if (entity.isActive) {
    const type = normalizeEntityType(entity.type);
    const conflict = type ? await findClubActiveEntityOfType(clubId, type, legalEntityId) : null;
    if (conflict) {
      throw new Error(`У клуба уже есть активное ${legalEntityTypeLabel(entity.type)}: «${conflict.name}». Допустимо одно активное ООО и одно активное ИП на клуб.`);
    }
  }

  await prisma.clubLegalEntity.upsert({
    where: { clubId_legalEntityId: { clubId, legalEntityId } },
    create: { clubId, legalEntityId },
    update: {},
  });
  await recordAudit({
    action: "legal_entity.attached",
    entityType: "ClubLegalEntity",
    entityId: legalEntityId,
    companyId: entity.companyId,
    clubId,
    userId: guard.ctx.user.id,
  });
  revalidatePath("/settings");
}

export async function detachLegalEntityFromClub(formData: FormData): Promise<void> {
  const clubId = String(formData.get("clubId") ?? "").trim();
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  const entity = await prisma.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!entity) throw new Error("Юрлицо не найдено");
  const guard = await requireManager(entity.companyId);
  if ("error" in guard) throw new Error(guard.error);

  await prisma.clubLegalEntity.deleteMany({ where: { clubId, legalEntityId } });
  await recordAudit({
    action: "legal_entity.detached",
    entityType: "ClubLegalEntity",
    entityId: legalEntityId,
    companyId: entity.companyId,
    clubId,
    userId: guard.ctx.user.id,
  });
  revalidatePath("/settings");
}
