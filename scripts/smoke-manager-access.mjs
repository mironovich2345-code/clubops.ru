// Smoke test: a manager invited to exactly one club resolves to a working scope.
//
// Reproduces the real invite -> accept -> access-resolution path against the
// running dev server (start it with `npm run dev` first), then asserts via the
// self-introspection endpoint /api/me/access that:
//   - effectiveRole === "manager"
//   - allowedClubIds contains exactly the assigned club
//   - the manager can reach the operational pages and create operationally
//
// Run: npm run smoke:manager   (requires `npm run dev` on http://localhost:3000)
import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";

const p = new PrismaClient();
const SECRET = process.env.SESSION_SECRET ?? "local-dev-secret-not-for-production";
const hashToken = (t) => createHmac("sha256", SECRET).update(t).digest("hex");
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const CO = "smoke-mgr-co";
const CLUB_A = "smoke-mgr-club-a";
const CLUB_B = "smoke-mgr-club-b";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
  cond ? pass++ : fail++;
};

async function cleanup() {
  await p.invite.deleteMany({ where: { companyId: CO } });
  await p.session.deleteMany({ where: { user: { email: { startsWith: "smoke-mgr-" } } } });
  await p.company.deleteMany({ where: { id: CO } }); // cascades clubs + club access
  await p.user.deleteMany({ where: { email: { startsWith: "smoke-mgr-" } } });
}

async function main() {
  await cleanup();

  // Two-club company so "resolves to exactly the assigned club" is meaningful.
  await p.company.create({ data: { id: CO, name: "Smoke Manager Co" } });
  await p.club.createMany({
    data: [
      { id: CLUB_A, companyId: CO, name: "Клуб A", city: "Москва" },
      { id: CLUB_B, companyId: CO, name: "Клуб B", city: "Питер" },
    ],
  });

  const owner = await p.user.create({ data: { email: "smoke-mgr-owner@t.local", name: "Owner", role: "manager", isActive: true } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: owner.id, role: "owner" } });

  const manager = await p.user.create({ data: { email: "smoke-mgr-user@t.local", name: "Manager", role: "manager", isActive: true } });

  // Simulate invite (club-scoped manager) -> accept (creates ClubUserAccess).
  await p.invite.create({
    data: {
      tokenHash: hashToken(randomBytes(8).toString("hex")),
      email: manager.email,
      companyId: CO,
      clubId: CLUB_A,
      role: "manager",
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 7 * 864e5),
      acceptedAt: new Date(),
    },
  });
  await p.clubUserAccess.create({ data: { clubId: CLUB_A, userId: manager.id, role: "manager" } });

  // Forge a session and ask the app to resolve the context (no scope cookies =
  // fresh login).
  const token = randomBytes(32).toString("hex");
  await p.session.create({ data: { userId: manager.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 864e5) } });

  const res = await fetch(`${BASE}/api/me/access`, { headers: { cookie: `club_ops_session=${token}` } });
  if (res.status !== 200) {
    check("GET /api/me/access returns 200", false, `status ${res.status} — is the dev server running?`);
    await finish();
    return;
  }
  const ctx = await res.json();

  check("effectiveRole === manager", ctx.effectiveRole === "manager", JSON.stringify(ctx.effectiveRole));
  check("selectedCompanyId resolves", ctx.selectedCompanyId === CO, JSON.stringify(ctx.selectedCompanyId));
  check("allowedClubIds === [club A] (exactly the assigned club)", Array.isArray(ctx.allowedClubIds) && ctx.allowedClubIds.length === 1 && ctx.allowedClubIds[0] === CLUB_A, JSON.stringify(ctx.allowedClubIds));
  check("selectedClubId === club A", ctx.selectedClubId === CLUB_A, JSON.stringify(ctx.selectedClubId));
  check("manager can create operationally", ctx.canCreateOperational === true, JSON.stringify(ctx.canCreateOperational));
  check("manager can access sales/expenses/invoices/refunds", ctx.pages?.sales && ctx.pages?.expenses && ctx.pages?.invoices && ctx.pages?.refunds, JSON.stringify(ctx.pages));

  await finish();
}

async function finish() {
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await cleanup();
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); try { await cleanup(); } catch {} await p.$disconnect(); process.exit(1); });
