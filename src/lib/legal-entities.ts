import type { LegalEntity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AccessContext } from "@/lib/access";
import type { Role } from "@/lib/auth";

// A company (tenant) operates clubs through one or more accounting entities:
// ООО (LLC) and/or ИП (sole proprietor). Entities are attached to clubs via
// ClubLegalEntity; a club may have ООО + ИП at once.

export type LegalEntityType = "ooo" | "ip";

export const LEGAL_ENTITY_TYPES: ReadonlyArray<{ key: LegalEntityType; label: string }> = [
  { key: "ooo", label: "ООО" },
  { key: "ip", label: "ИП" },
];

/** Normalize legacy ("ООО"/"ИП") and canonical ("ooo"/"ip") type values. */
export function normalizeEntityType(type: string): LegalEntityType | null {
  const t = type.trim().toLowerCase();
  if (t === "ooo" || t === "ооо") return "ooo";
  if (t === "ip" || t === "ип") return "ip";
  return null;
}

export function legalEntityTypeLabel(type: string): string {
  const n = normalizeEntityType(type);
  return n === "ooo" ? "ООО" : n === "ip" ? "ИП" : type;
}

export type LegalEntityDisplay = {
  name: string;
  inn: string | null;
  kpp: string | null;
  type: string;
  typeLabel: string;
};

/**
 * Canonical short display for a legal entity (name / INN / KPP / type). Reused
 * across forms and reserved for future document generation (contracts, acts,
 * returns, bank integrations).
 */
export function getLegalEntityDisplay(e: {
  name: string;
  shortName?: string | null;
  fullName?: string | null;
  inn?: string | null;
  kpp?: string | null;
  type: string;
}): LegalEntityDisplay {
  return {
    name: e.shortName || e.name || e.fullName || "",
    inn: e.inn ?? null,
    kpp: e.kpp ?? null,
    type: e.type,
    typeLabel: legalEntityTypeLabel(e.type),
  };
}

export function isEntityType(value: string): value is LegalEntityType {
  return value === "ooo" || value === "ip";
}

/** Owner / general director manage legal entities; everyone else is read-only. */
export function canManageLegalEntities(roles: readonly Role[]): boolean {
  return roles.includes("owner") || roles.includes("general_director");
}

export type LegalEntitySummary = {
  id: string;
  name: string;
  type: LegalEntityType | string;
  inn: string | null;
  kpp: string | null;
  isActive: boolean;
};

export async function getLegalEntitiesForCompany(
  companyId: string,
  opts?: { includeInactive?: boolean },
): Promise<LegalEntity[]> {
  return prisma.legalEntity.findMany({
    where: { companyId, ...(opts?.includeInactive ? {} : { isActive: true }) },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
}

// An association counts as ACTIVE only when BOTH the join row is active
// (the current assignment, not closed history) AND the entity itself is not
// globally archived. Centralized here so every consumer agrees.
const ACTIVE_ASSOCIATION_WHERE = { isActive: true, legalEntity: { isActive: true } } as const;

/**
 * Legal entities currently attached to a club. Active associations only by
 * default (join.isActive AND entity.isActive); pass includeInactive to also
 * return closed/historical associations. Each row carries isPrimary plus the
 * association's own isActive / deactivatedAt for history views.
 */
export async function getClubLegalEntities(
  clubId: string,
  opts?: { includeInactive?: boolean },
): Promise<Array<LegalEntity & { isPrimary: boolean; associationActive: boolean; deactivatedAt: Date | null }>> {
  const rows = await prisma.clubLegalEntity.findMany({
    where: { clubId, ...(opts?.includeInactive ? {} : ACTIVE_ASSOCIATION_WHERE) },
    include: { legalEntity: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    ...r.legalEntity,
    isPrimary: r.isPrimary,
    associationActive: r.isActive,
    deactivatedAt: r.deactivatedAt,
  }));
}

/**
 * The single ACTIVE legal entity of `type` for a club (Part 8 centralized
 * resolver — never "first linked entity"). Verifies type and active status.
 * Prefers the primary association when several exist (defensive). null if none.
 */
export async function getActiveClubLegalEntity(
  clubId: string,
  type: LegalEntityType,
): Promise<LegalEntity | null> {
  const entities = await getClubLegalEntities(clubId); // active associations only
  const ofType = entities.filter((e) => normalizeEntityType(e.type) === type);
  if (ofType.length === 0) return null;
  return ofType.find((e) => e.isPrimary) ?? ofType[0];
}

/** Active ООО + ИП for a club resolved together (Part 8). */
export async function getActiveClubLegalEntities(
  clubId: string,
): Promise<{ ooo: LegalEntity | null; ip: LegalEntity | null }> {
  const entities = await getClubLegalEntities(clubId);
  const pick = (t: LegalEntityType) => {
    const ofType = entities.filter((e) => normalizeEntityType(e.type) === t);
    return ofType.find((e) => e.isPrimary) ?? ofType[0] ?? null;
  };
  return { ooo: pick("ooo"), ip: pick("ip") };
}

/** Back-compat alias: active club entity of a given type. */
export async function getClubEntityByType(
  clubId: string,
  type: LegalEntityType,
): Promise<LegalEntity | null> {
  return getActiveClubLegalEntity(clubId, type);
}

/**
 * Business rule: a club may have at most ONE active ООО and ONE active ИП.
 * Returns the existing active entity of `type` attached to the club (excluding
 * `excludeEntityId`), or null if there is no conflict. Read-only.
 */
export async function findClubActiveEntityOfType(
  clubId: string,
  type: LegalEntityType,
  excludeEntityId?: string,
): Promise<LegalEntity | null> {
  const entities = await getClubLegalEntities(clubId); // active + attached only
  return entities.find((e) => normalizeEntityType(e.type) === type && e.id !== excludeEntityId) ?? null;
}

export type LegalEntityCheck =
  | { ok: true; type: LegalEntityType }
  | { ok: false; reason: "not_found" | "wrong_company" | "inactive" | "wrong_type" };

/**
 * Centralized server-side validation (Part 8) that a LegalEntity may be made an
 * ACTIVE assignment of `expectedType` for a club: it must exist, belong to the
 * club's Company, be globally active, and match the requested type. Returns a
 * typed result so callers can map to a safe Russian message — it never throws
 * and never leaks which check failed beyond these coarse reasons.
 */
export async function assertLegalEntityAvailableForClub(
  companyId: string,
  legalEntityId: string,
  expectedType: LegalEntityType,
): Promise<LegalEntityCheck> {
  const e = await prisma.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!e) return { ok: false, reason: "not_found" };
  if (e.companyId !== companyId) return { ok: false, reason: "wrong_company" };
  if (!e.isActive) return { ok: false, reason: "inactive" };
  const t = normalizeEntityType(e.type);
  if (t !== expectedType) return { ok: false, reason: "wrong_type" };
  return { ok: true, type: t };
}

/** Single legal entity scoped to the current company (no cross-company access). */
export async function getLegalEntityForContext(
  ctx: AccessContext,
  id: string,
): Promise<LegalEntity | null> {
  if (!ctx.selectedCompanyId) return null;
  const e = await prisma.legalEntity.findUnique({ where: { id } });
  if (!e || e.companyId !== ctx.selectedCompanyId) return null;
  return e;
}

export type CompanyLegalEntityRow = LegalEntity & {
  clubs: Array<{ clubId: string; clubName: string; isPrimary: boolean; associationActive: boolean }>;
};

/**
 * All company legal entities annotated with the clubs they're attached to
 * (settings view). Only ACTIVE associations are surfaced (closed history is not
 * shown here); each carries associationActive for clarity / future history UIs.
 */
export async function getCompanyLegalEntitiesWithClubs(companyId: string): Promise<CompanyLegalEntityRow[]> {
  const [entities, links] = await Promise.all([
    prisma.legalEntity.findMany({ where: { companyId }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.clubLegalEntity.findMany({
      where: { legalEntity: { companyId }, isActive: true },
      include: { club: { select: { id: true, name: true } } },
    }),
  ]);
  const byEntity = new Map<string, Array<{ clubId: string; clubName: string; isPrimary: boolean; associationActive: boolean }>>();
  for (const l of links) {
    const arr = byEntity.get(l.legalEntityId) ?? [];
    arr.push({ clubId: l.clubId, clubName: l.club.name, isPrimary: l.isPrimary, associationActive: l.isActive });
    byEntity.set(l.legalEntityId, arr);
  }
  return entities.map((e) => ({ ...e, clubs: byEntity.get(e.id) ?? [] }));
}
