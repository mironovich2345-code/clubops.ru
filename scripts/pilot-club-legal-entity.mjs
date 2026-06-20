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
