// STAGE 13: build cashier identities from receipts and manage identity → employee mappings.
// Idempotent (identityKey @unique). Suggestions are auto_matched/ambiguous/unmatched only —
// NEVER confirmed automatically; payroll attributes solely through confirmed/manually_assigned
// mappings. No money movement here.
import type { Prisma, PrismaClient, OfdCashierIdentity, OfdCashierMapping } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildIdentityKey, suggestEmployee, toCandidate, mappingIntervalsOverlap } from "@/lib/ofd/cashier-identity";

type Db = PrismaClient | Prisma.TransactionClient;

const EPOCH = new Date(0);

/**
 * Aggregate all receipts that carry an operator name (in scope) into OfdCashierIdentity rows,
 * and ensure each identity has a suggestion mapping when it has none yet. Returns counts.
 * Idempotent: re-runs update firstSeen/lastSeen/count/sum, never duplicate identities.
 */
export async function syncCashierIdentities(args: { companyId: string; clubIds?: string[] }): Promise<{ identities: number; suggestions: number; ambiguous: number; unmatched: number }> {
  const { companyId } = args;
  const receipts = await prisma.ofdReceiptImport.findMany({
    where: {
      companyId,
      operatorNormalized: { not: null },
      ...(args.clubIds ? { clubId: { in: args.clubIds } } : {}),
    },
    select: { provider: true, connectionId: true, clubId: true, legalEntityId: true, fnNumber: true, operatorName: true, operatorNormalized: true, externalCashierId: true, receiptDate: true, operationType: true, totalKopeks: true },
  });

  // Group by identity key.
  type Agg = { provider: string; connectionId: string; clubId: string; legalEntityId: string | null; fnNumber: string; rawName: string; normalizedName: string; externalCashierId: string | null; first: Date; last: Date; count: number; sum: number };
  const groups = new Map<string, Agg>();
  for (const r of receipts) {
    const norm = r.operatorNormalized as string;
    if (!norm) continue;
    const key = buildIdentityKey({ companyId, provider: r.provider, ofdConnectionId: r.connectionId, fnNumber: r.fnNumber, normalizedName: norm });
    const g = groups.get(key);
    const income = r.operationType === "income" ? r.totalKopeks : 0;
    if (!g) {
      groups.set(key, { provider: r.provider, connectionId: r.connectionId, clubId: r.clubId, legalEntityId: r.legalEntityId, fnNumber: r.fnNumber, rawName: r.operatorName ?? norm, normalizedName: norm, externalCashierId: r.externalCashierId, first: r.receiptDate, last: r.receiptDate, count: 1, sum: income });
    } else {
      g.count += 1;
      g.sum += income;
      if (r.receiptDate < g.first) g.first = r.receiptDate;
      if (r.receiptDate > g.last) g.last = r.receiptDate;
    }
  }

  let identities = 0, suggestions = 0, ambiguous = 0, unmatched = 0;
  for (const [identityKey, g] of groups) {
    const existing = await prisma.ofdCashierIdentity.findUnique({ where: { identityKey } });
    const identity = existing
      ? await prisma.ofdCashierIdentity.update({ where: { id: existing.id }, data: { firstSeenAt: g.first, lastSeenAt: g.last, receiptsCount: g.count, salesAmountKopeks: g.sum, clubId: g.clubId, legalEntityId: g.legalEntityId, rawName: g.rawName } })
      : await prisma.ofdCashierIdentity.create({ data: { companyId, provider: g.provider, ofdConnectionId: g.connectionId, clubId: g.clubId, legalEntityId: g.legalEntityId, externalCashierId: g.externalCashierId, rawName: g.rawName, normalizedName: g.normalizedName, firstSeenAt: g.first, lastSeenAt: g.last, receiptsCount: g.count, salesAmountKopeks: g.sum, status: "active", identityKey } });
    identities += 1;

    // Only propose a suggestion when there is NO mapping yet — never touch confirmed/manual.
    const hasMapping = await prisma.ofdCashierMapping.findFirst({ where: { cashierIdentityId: identity.id, status: { notIn: ["inactive"] } }, select: { id: true } });
    if (hasMapping) continue;

    const employees = g.clubId
      ? await prisma.clubEmployee.findMany({ where: { companyId, clubId: g.clubId }, select: { id: true, fullName: true, status: true, hireDate: true, dismissedAt: true } })
      : [];
    const suggestion = suggestEmployee(identity.normalizedName, employees.map(toCandidate), g.last);
    if (suggestion.status === "auto_matched") {
      await prisma.ofdCashierMapping.create({ data: { companyId, provider: g.provider, ofdConnectionId: g.connectionId, cashierIdentityId: identity.id, employeeId: suggestion.employeeId, clubId: g.clubId, legalEntityId: g.legalEntityId, status: "auto_matched", matchMethod: "exact_normalized_name", confidence: suggestion.confidence, effectiveFrom: g.first } });
      suggestions += 1;
    } else if (suggestion.status === "ambiguous") {
      await prisma.ofdCashierMapping.create({ data: { companyId, provider: g.provider, ofdConnectionId: g.connectionId, cashierIdentityId: identity.id, employeeId: null, clubId: g.clubId, legalEntityId: g.legalEntityId, status: "ambiguous", matchMethod: "exact_normalized_name", effectiveFrom: g.first, comment: `Кандидаты: ${suggestion.candidates.join(", ")}` } });
      ambiguous += 1;
    } else {
      await prisma.ofdCashierMapping.create({ data: { companyId, provider: g.provider, ofdConnectionId: g.connectionId, cashierIdentityId: identity.id, employeeId: null, clubId: g.clubId, legalEntityId: g.legalEntityId, status: "unmatched", matchMethod: "exact_normalized_name", effectiveFrom: g.first } });
      unmatched += 1;
    }
  }
  return { identities, suggestions, ambiguous, unmatched };
}

/** The current (open, non-inactive) mapping of an identity, if any. */
export async function currentMapping(identityId: string): Promise<OfdCashierMapping | null> {
  return prisma.ofdCashierMapping.findFirst({ where: { cashierIdentityId: identityId, effectiveTo: null, status: { notIn: ["inactive"] } }, orderBy: { effectiveFrom: "desc" } });
}

/**
 * Confirm / manually assign an employee to an identity (spec §19/§20). Reassigning to a
 * different employee CLOSES the current open interval (effectiveTo = now) and appends a new
 * mapping from `effectiveFrom` — historical receipts keep their old attribution (§8/§25).
 * Overlap of two open intervals for one identity is prevented.
 */
export async function assignEmployeeToIdentity(
  db: Db,
  args: { identity: OfdCashierIdentity; employeeId: string; clubId: string; legalEntityId: string | null; status: "confirmed" | "manually_assigned"; matchMethod: string; effectiveFrom: Date; confirmedById: string; comment?: string | null },
): Promise<OfdCashierMapping> {
  const open = await db.ofdCashierMapping.findMany({ where: { cashierIdentityId: args.identity.id, effectiveTo: null, status: { notIn: ["inactive"] } } });
  const now = new Date();
  for (const m of open) {
    // Close a genuine reassignment; a re-confirm of the same employee is a no-op update below.
    if (m.employeeId !== args.employeeId) {
      await db.ofdCashierMapping.update({ where: { id: m.id }, data: { effectiveTo: args.effectiveFrom <= m.effectiveFrom ? m.effectiveFrom : args.effectiveFrom, status: "inactive" } });
    }
  }
  const same = open.find((m) => m.employeeId === args.employeeId);
  if (same) {
    return db.ofdCashierMapping.update({ where: { id: same.id }, data: { status: args.status, matchMethod: args.matchMethod, confirmedById: args.confirmedById, confirmedAt: now, comment: args.comment ?? same.comment } });
  }
  // Guard: no overlapping open interval remains for this identity.
  const stillOpen = await db.ofdCashierMapping.findMany({ where: { cashierIdentityId: args.identity.id, effectiveTo: null, status: { notIn: ["inactive"] } } });
  for (const m of stillOpen) {
    if (mappingIntervalsOverlap({ effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo }, { effectiveFrom: args.effectiveFrom, effectiveTo: null })) {
      throw new Error("Пересечение интервалов mapping для одной identity запрещено.");
    }
  }
  return db.ofdCashierMapping.create({ data: { companyId: args.identity.companyId, provider: args.identity.provider, ofdConnectionId: args.identity.ofdConnectionId, cashierIdentityId: args.identity.id, employeeId: args.employeeId, clubId: args.clubId, legalEntityId: args.legalEntityId, status: args.status, matchMethod: args.matchMethod, effectiveFrom: args.effectiveFrom, confirmedById: args.confirmedById, confirmedAt: now, comment: args.comment ?? null } });
}

/** Exclude an identity from attribution (spec §19). Closes any open mapping. */
export async function excludeIdentity(db: Db, identityId: string, reason: string, byUserId: string): Promise<void> {
  await db.ofdCashierMapping.updateMany({ where: { cashierIdentityId: identityId, effectiveTo: null }, data: { status: "inactive", effectiveTo: new Date() } });
  await db.ofdCashierMapping.create({ data: await excludedMappingData(identityId, reason, byUserId) });
  await db.ofdCashierIdentity.update({ where: { id: identityId }, data: { status: "excluded" } });
}

async function excludedMappingData(identityId: string, reason: string, byUserId: string) {
  const identity = await prisma.ofdCashierIdentity.findUniqueOrThrow({ where: { id: identityId } });
  return { companyId: identity.companyId, provider: identity.provider, ofdConnectionId: identity.ofdConnectionId, cashierIdentityId: identityId, employeeId: null, clubId: identity.clubId ?? "", legalEntityId: identity.legalEntityId, status: "excluded", matchMethod: "manual", effectiveFrom: EPOCH, excludedReason: reason, confirmedById: byUserId, confirmedAt: new Date() } satisfies Prisma.OfdCashierMappingUncheckedCreateInput;
}
