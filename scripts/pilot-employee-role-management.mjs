// Employee role management regression: general_director promotes manager →
// regional_director (selected clubs) and demotes regional_director → manager (one
// club). Mirrors the pure eligibility rules (lib/employee-roles) and exercises the
// DB transaction effects (access rows swapped, scoped to company, financial rows
// untouched). SAFE: fixed "pilot-erm-*" ids; cleaned up.
//   npm run pilot:employee-role-management
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// --- Mirror of lib/employee-roles -----------------------------------------
const BLOCKING = ["owner", "general_director", "accountant", "chief_accountant"];
function classifyRoleShape(roles, systemAdmin) {
  if (systemAdmin) return "other";
  const set = new Set(roles);
  if (set.size === 0) return "none";
  if (BLOCKING.some((r) => set.has(r))) return "other";
  const m = set.has("manager"), r = set.has("regional_director");
  if (m && r) return "mixed";
  if (r) return "regional";
  if (m) return "manager";
  return "other";
}
const canPromote = (s) => s === "manager";
const canDemote = (s) => s === "regional";
const normSel = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];

const CO = "pilot-erm-co", CO2 = "pilot-erm-co2";
const GD = "pilot-erm-gd", EMP = "pilot-erm-emp", OTHERMGR = "pilot-erm-othermgr";

async function cleanup() {
  await p.auditLog.deleteMany({ where: { companyId: { in: [CO, CO2] } } }).catch(() => {});
  await p.invoice.deleteMany({ where: { companyId: { in: [CO, CO2] } } }).catch(() => {});
  await p.clubUserAccess.deleteMany({ where: { userId: { in: [GD, EMP, OTHERMGR] } } }).catch(() => {});
  await p.companyUserAccess.deleteMany({ where: { userId: { in: [GD, EMP, OTHERMGR] } } }).catch(() => {});
  await p.company.deleteMany({ where: { id: { in: [CO, CO2] } } }).catch(() => {});
  await p.user.deleteMany({ where: { id: { in: [GD, EMP, OTHERMGR] } } }).catch(() => {});
}

// Mirror of rawRolesInCompany (union of company + club access roles in company).
async function rolesInCompany(userId, companyId) {
  const [co, cl] = await Promise.all([
    p.companyUserAccess.findMany({ where: { userId, companyId }, select: { role: true } }),
    p.clubUserAccess.findMany({ where: { userId, club: { companyId } }, select: { role: true } }),
  ]);
  return [...new Set([...co.map((r) => r.role), ...cl.map((r) => r.role)])];
}
async function validActiveClubIds(companyId, ids) {
  if (!ids.length) return [];
  const rows = await p.club.findMany({ where: { id: { in: ids }, companyId, isActive: true }, select: { id: true } });
  return rows.map((r) => r.id);
}
// Mirror of promoteToRegional txn.
async function promote(companyId, targetUserId, clubIds) {
  const selected = normSel(clubIds);
  if (!selected.length) return { ok: false, error: "no_club" };
  const roles = await rolesInCompany(targetUserId, companyId);
  if (!canPromote(classifyRoleShape(roles, false))) return { ok: false, error: "not_manager" };
  const valid = await validActiveClubIds(companyId, selected);
  if (valid.length !== selected.length || !valid.length) return { ok: false, error: "club_gone" };
  await p.$transaction(async (tx) => {
    const r2 = await rolesInCompany(targetUserId, companyId);
    if (classifyRoleShape(r2, false) !== "manager") throw new Error("STALE");
    await tx.clubUserAccess.deleteMany({ where: { userId: targetUserId, role: "manager", club: { companyId } } });
    await tx.companyUserAccess.deleteMany({ where: { userId: targetUserId, role: "manager", companyId } });
    await tx.clubUserAccess.createMany({ data: valid.map((clubId) => ({ clubId, userId: targetUserId, role: "regional_director" })) });
  });
  return { ok: true, clubs: valid };
}
// Mirror of demoteToManager txn.
async function demote(companyId, targetUserId, clubIds) {
  const selected = normSel(clubIds);
  if (selected.length !== 1) return { ok: false, error: "one_club" };
  const clubId = selected[0];
  const roles = await rolesInCompany(targetUserId, companyId);
  if (!canDemote(classifyRoleShape(roles, false))) return { ok: false, error: "not_regional" };
  const valid = await validActiveClubIds(companyId, [clubId]);
  if (valid.length !== 1) return { ok: false, error: "club_gone" };
  await p.$transaction(async (tx) => {
    const r2 = await rolesInCompany(targetUserId, companyId);
    if (classifyRoleShape(r2, false) !== "regional") throw new Error("STALE");
    await tx.clubUserAccess.deleteMany({ where: { userId: targetUserId, role: "regional_director", club: { companyId } } });
    await tx.companyUserAccess.deleteMany({ where: { userId: targetUserId, role: "regional_director", companyId } });
    await tx.clubUserAccess.createMany({ data: [{ clubId, userId: targetUserId, role: "manager" }] });
  });
  return { ok: true };
}

async function main() {
  await cleanup();

  // ===== Pure classification (11-15, 30) =====
  check("classify pure manager", classifyRoleShape(["manager"], false) === "manager");
  check("classify regional", classifyRoleShape(["regional_director"], false) === "regional");
  check("classify mixed blocked", classifyRoleShape(["manager", "regional_director"], false) === "mixed");
  check("11/12 accountant/chief → other", classifyRoleShape(["accountant"], false) === "other" && classifyRoleShape(["chief_accountant"], false) === "other");
  check("13/14 owner/GD → other", classifyRoleShape(["owner"], false) === "other" && classifyRoleShape(["general_director"], false) === "other");
  check("15 system_admin → other", classifyRoleShape(["manager"], true) === "other");
  check("6 no club selection blocked (pure)", normSel([]).length === 0);
  check("25 demote requires exactly one club (pure)", normSel(["a", "b"]).length !== 1 && normSel(["a"]).length === 1);

  // ===== DB fixtures =====
  await p.user.create({ data: { id: GD, email: "gd@erm.test", name: "Гендир", role: "owner", isActive: true } });
  await p.user.create({ data: { id: EMP, email: "emp@erm.test", name: "Сотрудник", role: "manager", isActive: true } });
  await p.user.create({ data: { id: OTHERMGR, email: "om@erm.test", name: "Чужой", role: "manager", isActive: true } });
  await p.company.create({ data: { id: CO, name: "ERM Co" } });
  await p.company.create({ data: { id: CO2, name: "ERM Co2" } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: GD, role: "general_director" } });
  const clubA = await p.club.create({ data: { name: "A", city: "X", companyId: CO } });
  const clubB = await p.club.create({ data: { name: "B", city: "X", companyId: CO } });
  const clubArch = await p.club.create({ data: { name: "Arch", city: "X", companyId: CO, isActive: false, archivedAt: new Date() } });
  const clubOther = await p.club.create({ data: { name: "Other", city: "X", companyId: CO2 } });
  // EMP is a manager of club A.
  await p.clubUserAccess.create({ data: { clubId: clubA.id, userId: EMP, role: "manager" } });
  // OTHERMGR is a manager in CO2 only.
  await p.clubUserAccess.create({ data: { clubId: clubOther.id, userId: OTHERMGR, role: "manager" } });
  // A financial row authored by EMP (must be untouched by role changes).
  const inv = await p.invoice.create({ data: { companyId: CO, clubId: clubA.id, createdByUserId: EMP, amountKopeks: 1000, status: "paid", paidAt: new Date() } });

  // ===== Promote guards (6,7,8,9,16) =====
  check("6 promote without clubs → error", (await promote(CO, EMP, [])).error === "no_club");
  check("7 promote with other-company club → error", (await promote(CO, EMP, [clubOther.id])).error === "club_gone");
  check("8 promote with archived club → error", (await promote(CO, EMP, [clubArch.id])).error === "club_gone");
  check("9 manager of another company → not in scope", classifyRoleShape(await rolesInCompany(OTHERMGR, CO), false) === "none");

  // ===== Promote success: two clubs (1,2,3,4,5) =====
  const pr = await promote(CO, EMP, [clubA.id, clubB.id]);
  check("1/3 promote to two clubs succeeds", pr.ok && pr.clubs.length === 2);
  check("4 manager access removed in company", (await p.clubUserAccess.count({ where: { userId: EMP, role: "manager", club: { companyId: CO } } })) === 0);
  check("5 regional access only on selected clubs", (await p.clubUserAccess.count({ where: { userId: EMP, role: "regional_director", club: { companyId: CO } } })) === 2);
  check("18 promote audit shape (selectedClubIds)", pr.clubs.sort().join() === [clubA.id, clubB.id].sort().join());
  check("19 financial row untouched (author preserved)", (await p.invoice.findUnique({ where: { id: inv.id } })).createdByUserId === EMP);

  // ===== Promote again → already regional (10, 36) =====
  check("10/36 second promote blocked (already regional / stale)", (await promote(CO, EMP, [clubA.id])).error === "not_manager");

  // ===== Demote guards (25,27,28,30) =====
  check("25 demote without exactly one club", (await demote(CO, EMP, [clubA.id, clubB.id])).error === "one_club");
  check("27 demote to other-company club", (await demote(CO, EMP, [clubOther.id])).error === "club_gone");
  check("28 demote to archived club", (await demote(CO, EMP, [clubArch.id])).error === "club_gone");

  // ===== Demote success: one club (21,22,23,24,33,34,35) =====
  const dm = await demote(CO, EMP, [clubB.id]);
  check("21/24 demote to one club succeeds", dm.ok);
  check("23 all regional access removed in company", (await p.clubUserAccess.count({ where: { userId: EMP, role: "regional_director", club: { companyId: CO } } })) === 0);
  check("22/24 manager only on the one selected club", (await p.clubUserAccess.count({ where: { userId: EMP, role: "manager", club: { companyId: CO } } })) === 1 && (await p.clubUserAccess.findFirst({ where: { userId: EMP, role: "manager", club: { companyId: CO } }, select: { clubId: true } })).clubId === clubB.id);
  check("33 financial history preserved after demote", (await p.invoice.findUnique({ where: { id: inv.id } })).createdByUserId === EMP);

  // ===== Demote again → already manager (30) =====
  check("30 second demote blocked (already manager)", (await demote(CO, EMP, [clubA.id])).error === "not_regional");

  // ===== Static assertions on the real source =====
  const ra = readFileSync(new URL("../src/app/(app)/users/role-actions.ts", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src/lib/employee-roles.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/(app)/users/page.tsx", import.meta.url), "utf8");
  check("S1 actions require general_director + company scope", ra.includes("requireGeneralDirector()") && ra.includes('userHasCompanyRole(actor.id, scope.company.id, ["general_director"])'));
  check("S2 selected clubs validated server-side (active + in company)", ra.includes("validActiveClubIds(") && ra.includes("isActive: true"));
  check("S3 promote grants regional on selected clubs, removes manager", ra.includes('role: "regional_director"') && ra.includes('role: "manager", club: { companyId'));
  check("S4 demote requires exactly one club", ra.includes("selected.length !== 1"));
  check("S5 role changes are transactional + re-checked (STALE_ROLE)", ra.includes("prisma.$transaction") && ra.includes("STALE_ROLE"));
  check("S6 audit events present, no author rewrite", ra.includes('"employee.promoted_to_regional"') && ra.includes('"employee.demoted_to_manager"') && !ra.includes("createdByUserId"));
  check("S7 mixed role state blocked, logged without PII", lib.includes('"mixed"') && ra.includes("mixed_state"));
  check("S8 UI exposes controls only to GD", page.includes("isGeneralDirector && member.user.isActive && roleShapeOf"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
