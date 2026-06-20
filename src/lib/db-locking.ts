// Provider-safe row locking + the Club active-assignment invariant.
//
// Production is PostgreSQL (supports `SELECT ... FOR UPDATE` row locks);
// development is SQLite (no row locks, but writes are serialized — a single
// writer at a time — so a write transaction already excludes concurrent
// writers). We therefore acquire an explicit Club-row lock on PostgreSQL and
// rely on SQLite's serialized-writer behavior plus the defensive invariant
// check elsewhere. The same transaction must hold the lock for the whole
// read-modify-write to be effective.
import type { Prisma } from "@prisma/client";
import { normalizeEntityType } from "@/lib/legal-entities";

// Prisma's interactive-transaction client (same shape in the dev SQLite and
// prod PostgreSQL generated clients).
type TxClient = Prisma.TransactionClient;

/**
 * Detect the active database provider from the established project configuration
 * (DATABASE_URL in .env). Never derived from request data. SQLite dev uses a
 * `file:` URL; PostgreSQL prod uses a `postgres(ql)://` URL.
 */
export function databaseProvider(): "postgresql" | "sqlite" {
  const url = process.env.DATABASE_URL ?? "";
  return /^postgres(ql)?:\/\//i.test(url) ? "postgresql" : "sqlite";
}

/**
 * Acquire a row lock on the given Club inside the CURRENT transaction. On
 * PostgreSQL this is `SELECT id FROM "Club" WHERE id = $1 FOR UPDATE`, which
 * serializes every assignment mutation for that Club. On SQLite this is a no-op
 * (the write transaction is already serialized against other writers). Must be
 * called as the FIRST statement of the transaction, before reading/modifying
 * ClubLegalEntity, so all callers contend on the same stable row.
 */
export async function lockClubRow(tx: TxClient, clubId: string): Promise<void> {
  if (databaseProvider() === "postgresql") {
    // Parameterized — clubId is bound, not interpolated.
    await tx.$queryRaw`SELECT id FROM "Club" WHERE id = ${clubId} FOR UPDATE`;
  }
  // SQLite: serialized writers; the transaction itself provides exclusion.
}

/**
 * Acquire a row lock on the given Company inside the CURRENT transaction. Used
 * to serialize Club CREATION per Company so two concurrent requests for the same
 * (Company, City, name) cannot both pass the duplicate check. PostgreSQL locks
 * the Company row; SQLite relies on serialized writers.
 */
export async function lockCompanyRow(tx: TxClient, companyId: string): Promise<void> {
  if (databaseProvider() === "postgresql") {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`;
  }
}

// Sentinel thrown by the invariant guard so callers can map it to a safe message.
export const ASSIGNMENT_CONFLICT = "ASSIGNMENT_CONFLICT";

/**
 * Defensive post-mutation invariant check (run inside the locked transaction,
 * before commit). For the target Club every ACTIVE association must point to an
 * active LegalEntity of the same Company, and there may be at most one active
 * ООО and one active ИП. Throws ASSIGNMENT_CONFLICT on any violation so the
 * transaction rolls back.
 */
export async function assertClubAssignmentInvariant(
  tx: TxClient,
  clubId: string,
  companyId: string,
): Promise<void> {
  const active = await tx.clubLegalEntity.findMany({
    where: { clubId, isActive: true },
    include: { legalEntity: { select: { companyId: true, type: true, isActive: true } } },
  });

  let ooo = 0;
  let ip = 0;
  const seen = new Set<string>();
  for (const a of active) {
    if (seen.has(a.legalEntityId)) throw new Error(ASSIGNMENT_CONFLICT); // duplicate active association
    seen.add(a.legalEntityId);
    if (!a.legalEntity.isActive) throw new Error(ASSIGNMENT_CONFLICT);
    if (a.legalEntity.companyId !== companyId) throw new Error(ASSIGNMENT_CONFLICT);
    const t = normalizeEntityType(a.legalEntity.type);
    if (t === "ooo") ooo += 1;
    else if (t === "ip") ip += 1;
  }
  if (ooo > 1 || ip > 1) throw new Error(ASSIGNMENT_CONFLICT);
}
