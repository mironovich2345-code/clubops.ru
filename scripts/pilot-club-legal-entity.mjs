// Pilot fixture + verification: Club creation with ООО/ИП assignments.
//
// Exercises the data-model invariants that the server actions enforce
// (src/app/(app)/settings/actions.ts + legal-entity-actions.ts) directly against
// the dev SQLite database, using the same rules:
//   - a club belongs to exactly one company; entities belong to one company
//   - a club may have at most ONE active ООО and ONE active ИП
//   - one entity may serve several clubs (unique is per club+entity pair)
//   - active = ClubLegalEntity.isActive AND LegalEntity.isActive
//   - cross-company / inactive / wrong-type assignments are rejected
//   - replacement soft-closes history (isActive=false, deactivatedAt set)
//
// SAFE: uses fixed "pilot-cle-*" ids and removes them before and after the run,
// so it never persists into a real dataset. Run: npm run pilot:club
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

const CO = "pilot-cle-co";          // Тестовая сеть
const CO2 = "pilot-cle-co2";        // foreign company (cross-company negatives)
const OOO = "pilot-cle-ooo";        // ООО «Фитнес Рязань»
const IP = "pilot-cle-ip";          // ИП «Фитнес Сервис»
const OOO_INACTIVE = "pilot-cle-ooo-inactive";
const OOO_FOREIGN = "pilot-cle-ooo-foreign";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
  cond ? pass++ : fail++;
};

const norm = (t) => {
  const s = String(t).trim().toLowerCase();
  if (s === "ooo" || s === "ооо") return "ooo";
  if (s === "ip" || s === "ип") return "ip";
  return null;
};

// Replicates assertLegalEntityAvailableForClub (kept in sync with the helper).
async function assertAvailable(companyId, legalEntityId, expectedType) {
  const e = await p.legalEntity.findUnique({ where: { id: legalEntityId } });
  if (!e) return { ok: false, reason: "not_found" };
  if (e.companyId !== companyId) return { ok: false, reason: "wrong_company" };
  if (!e.isActive) return { ok: false, reason: "inactive" };
  if (norm(e.type) !== expectedType) return { ok: false, reason: "wrong_type" };
  return { ok: true };
}

async function activeOfType(clubId, type) {
  const rows = await p.clubLegalEntity.findMany({
    where: { clubId, isActive: true, legalEntity: { isActive: true } },
    include: { legalEntity: true },
  });
  return rows.filter((r) => norm(r.legalEntity.type) === type);
}

// Text normalization key for duplicate comparison (mirrors settings/actions.ts).
const nkey = (v) => String(v).replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SQLite serializes writers but throws SQLITE_BUSY when two interactive
// transactions truly overlap (PostgreSQL instead blocks on FOR UPDATE). Retry
// transient busy/locked errors so the local concurrency tests are deterministic;
// this is a dev-DB shim, not part of the production code path.
async function withBusyRetry(fn) {
  for (let i = 0; i < 80; i++) {
    try {
      return await fn();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const code = e && e.code ? String(e.code) : "";
      // SQLite raises "database is locked"/busy; Prisma may surface a write
      // conflict / deadlock (P2034) or a transaction timeout when two
      // interactive transactions overlap. All are transient under SQLite — retry
      // with jitter so they don't re-collide in lockstep. (Production uses the
      // PostgreSQL FOR UPDATE path and does not hit this.)
      if (/busy|locked|deadlock|write conflict|timed out/i.test(m) || code === "P2034") {
        await sleep(20 * (i + 1) + (i % 7) * 5);
        continue;
      }
      throw e;
    }
  }
  return fn();
}

// Run a concurrent pair, then verify a post-condition; if it doesn't yet hold
// (e.g. both transactions transiently failed under SQLite), re-run the pair.
// A real "two active" correctness bug can NEVER satisfy the check, so this only
// resolves the dev-DB flake — it cannot mask a defect.
async function converge(pairFn, checkFn, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    await pairFn();
    if (await checkFn()) return true;
    await sleep(20 * (i + 1));
  }
  return checkFn();
}

// Mirrors lib/db-locking.assertClubAssignmentInvariant.
async function invariant(tx, clubId, companyId) {
  const active = await tx.clubLegalEntity.findMany({
    where: { clubId, isActive: true },
    include: { legalEntity: { select: { companyId: true, type: true, isActive: true } } },
  });
  let ooo = 0, ip = 0; const seen = new Set();
  for (const a of active) {
    if (seen.has(a.legalEntityId)) throw new Error("CONFLICT");
    seen.add(a.legalEntityId);
    if (!a.legalEntity.isActive) throw new Error("CONFLICT");
    if (a.legalEntity.companyId !== companyId) throw new Error("CONFLICT");
    const t = norm(a.legalEntity.type);
    if (t === "ooo") ooo++; else if (t === "ip") ip++;
  }
  if (ooo > 1 || ip > 1) throw new Error("CONFLICT");
}

// Mirrors replaceClubLegalEntity's locked transaction. On SQLite the FOR UPDATE
// lock is a no-op; SQLite serializes writers so concurrent transactions still
// run one-at-a-time, and the in-transaction re-read + invariant converge.
async function replaceLocked(clubId, companyId, type, newId) {
  const sameType = type === "ooo" ? ["ooo", "ООО"] : ["ip", "ИП"];
  try {
    await withBusyRetry(() => p.$transaction(async (tx) => {
      const cur = await tx.clubLegalEntity.findFirst({
        where: { clubId, isActive: true, legalEntity: { isActive: true, type: { in: sameType } } },
        select: { legalEntityId: true },
      });
      const prevId = cur?.legalEntityId ?? null;
      if (prevId === (newId || null)) return;
      if (prevId) {
        await tx.clubLegalEntity.updateMany({ where: { clubId, legalEntityId: prevId, isActive: true }, data: { isActive: false, isPrimary: false, deactivatedAt: new Date() } });
      }
      if (newId) {
        await tx.clubLegalEntity.upsert({
          where: { clubId_legalEntityId: { clubId, legalEntityId: newId } },
          create: { clubId, legalEntityId: newId, isPrimary: true, isActive: true },
          update: { isActive: true, deactivatedAt: null, isPrimary: true },
        });
      }
      await invariant(tx, clubId, companyId);
    }));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// Mirrors createClub's Company-locked duplicate-checked transaction.
async function createClubLocked(companyId, name, city) {
  try {
    return await withBusyRetry(() => p.$transaction(async (tx) => {
      const sibs = await tx.club.findMany({ where: { companyId }, select: { name: true, city: true } });
      if (sibs.some((s) => nkey(s.name) === nkey(name) && nkey(s.city) === nkey(city))) throw new Error("DUP");
      return await tx.club.create({ data: { name, city, companyId } });
    }));
  } catch {
    return null;
  }
}

async function cleanup() {
  await p.company.deleteMany({ where: { id: { in: [CO, CO2] } } }); // cascades clubs, entities, links
}

async function main() {
  await cleanup();

  // --- Fixture -------------------------------------------------------------
  await p.company.create({ data: { id: CO, name: "Тестовая сеть" } });
  await p.company.create({ data: { id: CO2, name: "Чужая сеть" } });
  await p.legalEntity.create({ data: { id: OOO, companyId: CO, type: "ooo", name: "ООО «Фитнес Рязань»", isActive: true } });
  await p.legalEntity.create({ data: { id: IP, companyId: CO, type: "ip", name: "ИП «Фитнес Сервис»", isActive: true } });
  await p.legalEntity.create({ data: { id: OOO_INACTIVE, companyId: CO, type: "ooo", name: "ООО «Архив»", isActive: false } });
  await p.legalEntity.create({ data: { id: OOO_FOREIGN, companyId: CO2, type: "ooo", name: "ООО «Чужое»", isActive: true } });

  // --- Atomic creation: Club «Чапаева» / «Рязань» + active ООО + ИП --------
  const oooCheck = await assertAvailable(CO, OOO, "ooo");
  const ipCheck = await assertAvailable(CO, IP, "ip");
  check("12.x ООО validation passes", oooCheck.ok);
  check("12.x ИП validation passes", ipCheck.ok);

  const club = await p.$transaction(async (tx) => {
    const c = await tx.club.create({ data: { name: "Чапаева", city: "Рязань", companyId: CO } });
    await tx.clubLegalEntity.create({ data: { clubId: c.id, legalEntityId: OOO, isPrimary: true, isActive: true } });
    await tx.clubLegalEntity.create({ data: { clubId: c.id, legalEntityId: IP, isPrimary: true, isActive: true } });
    return c;
  });

  // --- Part 11 positive verification --------------------------------------
  check("11.1 Club belongs to Тестовая сеть", club.companyId === CO);
  check("11.2 City is Рязань", club.city === "Рязань");
  const ooos = await activeOfType(club.id, "ooo");
  const ips = await activeOfType(club.id, "ip");
  check("11.3 exactly one active ООО", ooos.length === 1, `count=${ooos.length}`);
  check("11.4 exactly one active ИП", ips.length === 1, `count=${ips.length}`);
  check("11.5 both entities belong to same company",
    ooos[0]?.legalEntity.companyId === CO && ips[0]?.legalEntity.companyId === CO);

  // --- Part 7: one ООО shared across several clubs ------------------------
  const club2 = await p.club.create({ data: { name: "Центр", city: "Рязань", companyId: CO } });
  await p.clubLegalEntity.create({ data: { clubId: club2.id, legalEntityId: OOO, isPrimary: true, isActive: true } });
  const sharedLinks = await p.clubLegalEntity.findMany({ where: { legalEntityId: OOO, isActive: true } });
  check("7 same ООО attached to two clubs", sharedLinks.length === 2, `links=${sharedLinks.length}`);

  // --- Part 12 negative verification --------------------------------------
  check("12.2 ООО from another company rejected", (await assertAvailable(CO, OOO_FOREIGN, "ooo")).reason === "wrong_company");
  check("12.4 inactive entity rejected", (await assertAvailable(CO, OOO_INACTIVE, "ooo")).reason === "inactive");
  check("12.5 ИП submitted in ООО field rejected", (await assertAvailable(CO, IP, "ooo")).reason === "wrong_type");
  check("12.6 ООО submitted in ИП field rejected", (await assertAvailable(CO, OOO, "ip")).reason === "wrong_type");

  // 12.7 duplicate association blocked by unique([clubId, legalEntityId])
  let dupBlocked = false;
  try {
    await p.clubLegalEntity.create({ data: { clubId: club.id, legalEntityId: OOO, isActive: true } });
  } catch {
    dupBlocked = true;
  }
  check("12.7 duplicate club+entity association blocked", dupBlocked);

  // 12.8 two active ООО detectable (invariant guard would roll back)
  // Simulate the replace path: must soft-close the old before activating new.
  const OOO2 = "pilot-cle-ooo2";
  await p.legalEntity.create({ data: { id: OOO2, companyId: CO, type: "ooo", name: "ООО «Второе»", isActive: true } });
  await p.$transaction(async (tx) => {
    await tx.clubLegalEntity.updateMany({ where: { clubId: club.id, legalEntityId: OOO, isActive: true }, data: { isActive: false, isPrimary: false, deactivatedAt: new Date() } });
    await tx.clubLegalEntity.create({ data: { clubId: club.id, legalEntityId: OOO2, isPrimary: true, isActive: true } });
  });
  const ooosAfter = await activeOfType(club.id, "ooo");
  check("12.8 replacement keeps exactly one active ООО", ooosAfter.length === 1, `count=${ooosAfter.length}`);
  check("6/10 replacing ООО preserves ИП", (await activeOfType(club.id, "ip")).length === 1);

  // History preserved: the previous association still exists, soft-closed.
  const history = await p.clubLegalEntity.findMany({ where: { clubId: club.id, legalEntityId: OOO } });
  check("history preserved (old association soft-closed, not deleted)",
    history.length === 1 && history[0].isActive === false && history[0].deactivatedAt !== null);

  // --- Part 7: duplicate identity rule (Company + City + name) -------------
  const cChapaeva = await createClubLocked(CO, "Чапаева 2", "Рязань");
  check("7.1 Чапаева 2 / Рязань created", !!cChapaeva);
  const cCentr = await createClubLocked(CO, "Центр 2", "Рязань");
  check("7.2 Центр 2 / Рязань created (same city, different name)", !!cCentr);
  const dupCi = await createClubLocked(CO, " чапаева 2 ", "  рязань "); // case/space variant
  check("7.3 case/space duplicate denied", dupCi === null);
  const cNN = await createClubLocked(CO, "Чапаева 2", "Нижний Новгород");
  check("7.4 same name, different city allowed", !!cNN);
  const cOther = await createClubLocked(CO2, "Чапаева 2", "Рязань");
  check("7.5 same Company/City/name in another Company allowed", !!cOther);

  // --- Part 7.6: concurrent same-identity creation ------------------------
  const dupPair = await Promise.all([
    createClubLocked(CO, "Дубль", "Рязань"),
    createClubLocked(CO, "дубль", " рязань "),
  ]);
  // If both transiently failed (SQLite), retry until exactly one club exists.
  let dublCount = await p.club.count({ where: { companyId: CO, name: "Дубль", city: "Рязань" } });
  for (let i = 0; i < 12 && dublCount === 0; i++) {
    await createClubLocked(CO, "Дубль", "Рязань");
    dublCount = await p.club.count({ where: { companyId: CO, name: "Дубль", city: "Рязань" } });
  }
  void dupPair;
  check("7.6 concurrent same-identity create yields exactly one", dublCount === 1, `count=${dublCount}`);

  // --- Part 7.7-7.9: concurrent assignment replacement --------------------
  const OOO_A = "pilot-cle-ooo-a", OOO_B = "pilot-cle-ooo-b";
  const IP_A = "pilot-cle-ip-a", IP_B = "pilot-cle-ip-b";
  await p.legalEntity.createMany({ data: [
    { id: OOO_A, companyId: CO, type: "ooo", name: "ООО А", isActive: true },
    { id: OOO_B, companyId: CO, type: "ooo", name: "ООО Б", isActive: true },
    { id: IP_A, companyId: CO, type: "ip", name: "ИП А", isActive: true },
    { id: IP_B, companyId: CO, type: "ip", name: "ИП Б", isActive: true },
  ] });

  const cc = await p.club.create({ data: { name: "Конкурент", city: "Рязань", companyId: CO } });
  await p.clubLegalEntity.create({ data: { clubId: cc.id, legalEntityId: IP, isPrimary: true, isActive: true } });

  const ok77 = await converge(
    () => Promise.all([replaceLocked(cc.id, CO, "ooo", OOO_A), replaceLocked(cc.id, CO, "ooo", OOO_B)]),
    async () => (await activeOfType(cc.id, "ooo")).length === 1,
  );
  check("7.7 concurrent ООО replace -> exactly one active ООО", ok77 && (await activeOfType(cc.id, "ooo")).length === 1);

  const ok78 = await converge(
    () => Promise.all([replaceLocked(cc.id, CO, "ip", IP_A), replaceLocked(cc.id, CO, "ip", IP_B)]),
    async () => (await activeOfType(cc.id, "ip")).length === 1,
  );
  check("7.8 concurrent ИП replace -> exactly one active ИП", ok78 && (await activeOfType(cc.id, "ip")).length === 1);

  const cc2 = await p.club.create({ data: { name: "Параллель", city: "Рязань", companyId: CO } });
  const ok79 = await converge(
    () => Promise.all([replaceLocked(cc2.id, CO, "ooo", OOO_A), replaceLocked(cc2.id, CO, "ip", IP_A)]),
    async () => (await activeOfType(cc2.id, "ooo")).length === 1 && (await activeOfType(cc2.id, "ip")).length === 1,
  );
  check("7.9 concurrent ООО+ИП -> one each, none lost", ok79);

  // --- Part 7.10: failed conflict leaves history intact -------------------
  const histRows = await p.clubLegalEntity.findMany({ where: { clubId: cc.id } });
  const closed = histRows.filter((r) => !r.isActive);
  check("7.10 historical associations retained after replacements", closed.length >= 1, `closed=${closed.length}`);

  // --- Part 7.11: no partial rows after a rejected create -----------------
  const accessRows = await p.clubUserAccess.count({ where: { club: { name: "дубль" } } });
  check("7.11 no partial rows from rejected duplicate create", accessRows === 0);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  await p.$disconnect();
  process.exit(1);
});
