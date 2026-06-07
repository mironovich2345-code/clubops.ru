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

/** Legal entities attached to a club (active by default), with isPrimary. */
export async function getClubLegalEntities(
  clubId: string,
  opts?: { includeInactive?: boolean },
): Promise<Array<LegalEntity & { isPrimary: boolean }>> {
  const rows = await prisma.clubLegalEntity.findMany({
    where: { clubId, ...(opts?.includeInactive ? {} : { legalEntity: { isActive: true } }) },
    include: { legalEntity: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ ...r.legalEntity, isPrimary: r.isPrimary }));
}

/** Active club entity of a given type (prefers the primary one). null if none. */
export async function getClubEntityByType(
  clubId: string,
  type: LegalEntityType,
): Promise<LegalEntity | null> {
  const entities = await getClubLegalEntities(clubId);
  const ofType = entities.filter((e) => normalizeEntityType(e.type) === type);
  if (ofType.length === 0) return null;
  return ofType.find((e) => e.isPrimary) ?? ofType[0];
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

export type CompanyLegalEntityRow = LegalEntity & { clubs: Array<{ clubId: string; clubName: string; isPrimary: boolean }> };

/** All company legal entities annotated with the clubs they're attached to (settings view). */
export async function getCompanyLegalEntitiesWithClubs(companyId: string): Promise<CompanyLegalEntityRow[]> {
  const [entities, links] = await Promise.all([
    prisma.legalEntity.findMany({ where: { companyId }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.clubLegalEntity.findMany({
      where: { legalEntity: { companyId } },
      include: { club: { select: { id: true, name: true } } },
    }),
  ]);
  const byEntity = new Map<string, Array<{ clubId: string; clubName: string; isPrimary: boolean }>>();
  for (const l of links) {
    const arr = byEntity.get(l.legalEntityId) ?? [];
    arr.push({ clubId: l.clubId, clubName: l.club.name, isPrimary: l.isPrimary });
    byEntity.set(l.legalEntityId, arr);
  }
  return entities.map((e) => ({ ...e, clubs: byEntity.get(e.id) ?? [] }));
}
