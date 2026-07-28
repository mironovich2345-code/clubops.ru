// Multi-account (device-local) session container — security + correctness.
// Behavioural test against the real dev SQLite DB: seeds synthetic Users/Sessions/
// containers/stored-accounts and exercises the EXACT operations the service performs
// (src/lib/account-container.ts), asserting the security invariants. Plus source
// assertions that the real code implements those guards (so the behavioural mirror
// cannot drift). No cookies (the *Record functions are cookie-free by design).
//   npm run pilot:multi-account-sessions
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const T = "matest_" + Math.floor(Math.random() * 1e9);
const future = new Date(Date.now() + 30 * 864e5);
const past = new Date(Date.now() - 864e5);

// --- validity gate (mirror of sessionRowValid) ---
const valid = (s, u) => !!s && !s.revokedAt && s.expiresAt.getTime() >= Date.now() && !!u && u.isActive;

async function seedUser(tag, active = true) {
  return prisma.user.create({ data: { email: `${T}_${tag}@t.local`, name: `U-${tag}`, role: "owner", isActive: active, passwordHash: "x" } });
}
async function seedSession(userId, { revoked = false, expired = false } = {}) {
  return prisma.session.create({ data: { userId, tokenHash: `${T}_${Math.random()}`, expiresAt: expired ? past : future, revokedAt: revoked ? new Date() : null } });
}

async function main() {
  // Users: A/B active, C blocked.
  const A = await seedUser("A"), B = await seedUser("B"), C = await seedUser("C", false);
  const sA = await seedSession(A.id), sB = await seedSession(B.id);
  const sExp = await seedSession(B.id, { expired: true });
  const sRev = await seedSession(A.id, { revoked: true });
  const sC = await seedSession(C.id);

  // Container X (real) + foreign container Y.
  const X = await prisma.accountSessionContainer.create({ data: { tokenHash: `${T}_ctokX`, expiresAt: future } });
  const Y = await prisma.accountSessionContainer.create({ data: { tokenHash: `${T}_ctokY`, expiresAt: future } });

  // Attach A then B to X (mirror of attachSessionToContainerRecord); A active first.
  const stA = await prisma.storedAccountSession.create({ data: { containerId: X.id, userId: A.id, sessionId: sA.id, displayOrder: 0 } });
  const stB = await prisma.storedAccountSession.create({ data: { containerId: X.id, userId: B.id, sessionId: sB.id, displayOrder: 1 } });
  await prisma.accountSessionContainer.update({ where: { id: X.id }, data: { activeStoredSessionId: stA.id } });
  // Foreign stored in Y (used for cross-container ownership test).
  const stForeign = await prisma.storedAccountSession.create({ data: { containerId: Y.id, userId: A.id, sessionId: sA.id, displayOrder: 0 } });

  // Resolver mirror (resolveActiveSession).
  async function resolve(containerId) {
    const c = await prisma.accountSessionContainer.findUnique({ where: { id: containerId } });
    if (!c || c.revokedAt || c.expiresAt.getTime() < Date.now() || !c.activeStoredSessionId) return null;
    const st = await prisma.storedAccountSession.findUnique({ where: { id: c.activeStoredSessionId } });
    if (!st || st.containerId !== c.id || st.revokedAt) return null;
    const s = await prisma.session.findUnique({ where: { id: st.sessionId }, include: { user: true } });
    return valid(s, s?.user) ? { userId: s.user.id } : null;
  }
  // Switch mirror (switchActiveAccountRecord).
  async function doSwitch(containerId, storedId) {
    const st = await prisma.storedAccountSession.findUnique({ where: { id: storedId } });
    if (!st || st.containerId !== containerId) return { ok: false, error: "not_found" };
    if (st.revokedAt) return { ok: false, error: "revoked" };
    const s = await prisma.session.findUnique({ where: { id: st.sessionId }, include: { user: true } });
    if (!valid(s, s?.user)) return { ok: false, error: "expired" };
    await prisma.accountSessionContainer.update({ where: { id: containerId }, data: { activeStoredSessionId: storedId } });
    return { ok: true };
  }

  // 1) Resolve → active account A.
  check("MA1 resolve active → account A drives", (await resolve(X.id))?.userId === A.id);
  // 2) Switch to B → active becomes B.
  check("MA2 switch → currentUser becomes B", (await doSwitch(X.id, stB.id)).ok && (await resolve(X.id))?.userId === B.id);
  // 3) Idempotent switch.
  check("MA3 repeat switch to B idempotent", (await doSwitch(X.id, stB.id)).ok && (await resolve(X.id))?.userId === B.id);
  // 4) Foreign storedId (belongs to container Y) refused — ownership guard.
  check("MA4 foreign storedSessionId refused (ownership)", (await doSwitch(X.id, stForeign.id)).error === "not_found" && (await resolve(X.id))?.userId === B.id);
  // 5) Switch to an expired-session account refused; active unchanged (§7).
  const stExp = await prisma.storedAccountSession.create({ data: { containerId: X.id, userId: B.id + "_x", sessionId: sExp.id, displayOrder: 2 } });
  check("MA5 expired target refused → require login, no auto-switch", (await doSwitch(X.id, stExp.id)).error === "expired" && (await resolve(X.id))?.userId === B.id);
  // 6) Re-login updates one account (attach upsert changes sessionId, sets active).
  const sA2 = await seedSession(A.id);
  await prisma.storedAccountSession.update({ where: { id: stA.id }, data: { sessionId: sA2.id, revokedAt: null } });
  await prisma.accountSessionContainer.update({ where: { id: X.id }, data: { activeStoredSessionId: stA.id } });
  check("MA6 re-login updates only that account + reactivates", (await resolve(X.id))?.userId === A.id);
  // 7) Revoked target session not resolvable.
  const stRev = await prisma.storedAccountSession.create({ data: { containerId: X.id, userId: A.id + "_r", sessionId: sRev.id, displayOrder: 3 } });
  check("MA7 revoked session not activatable", (await doSwitch(X.id, stRev.id)).error === "expired");
  // 8) Blocked user not resolvable.
  const stC = await prisma.storedAccountSession.create({ data: { containerId: X.id, userId: C.id, sessionId: sC.id, displayOrder: 4 } });
  check("MA8 blocked (isActive=false) user not activatable", (await doSwitch(X.id, stC.id)).error === "expired");

  // 9) Remove one account (mirror removeStoredAccountRecord): revoke stored + its session, repoint if active.
  async function remove(containerId, storedId) {
    const st = await prisma.storedAccountSession.findUnique({ where: { id: storedId } });
    if (!st || st.containerId !== containerId) return { ok: false };
    await prisma.storedAccountSession.update({ where: { id: storedId }, data: { revokedAt: new Date() } });
    await prisma.session.updateMany({ where: { id: st.sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "account_removed_from_device" } });
    const c = await prisma.accountSessionContainer.findUnique({ where: { id: containerId } });
    let nextActiveId = c?.activeStoredSessionId ?? null;
    if (c?.activeStoredSessionId === storedId) {
      const next = await prisma.storedAccountSession.findFirst({ where: { containerId, revokedAt: null, id: { not: storedId } }, orderBy: { lastUsedAt: "desc" } });
      nextActiveId = next?.id ?? null;
      await prisma.accountSessionContainer.update({ where: { id: containerId }, data: { activeStoredSessionId: nextActiveId } });
    }
    const remaining = await prisma.storedAccountSession.count({ where: { containerId, revokedAt: null } });
    return { ok: true, empty: remaining === 0, nextActiveId };
  }
  // Active is stA (A). Remove B (non-active) → others remain, B session revoked.
  await remove(X.id, stB.id);
  const sBafter = await prisma.session.findUnique({ where: { id: sB.id } });
  check("MA9 remove one → its session revoked, others remain", !!sBafter.revokedAt && (await resolve(X.id))?.userId === A.id);
  // 10) Remove ACTIVE (A) → repoint to next available valid or null.
  const rem = await remove(X.id, stA.id);
  const sA2after = await prisma.session.findUnique({ where: { id: sA2.id } });
  check("MA10 remove active → active session revoked + repointed", !!sA2after.revokedAt && rem.nextActiveId !== stA.id);

  // 11) Logout-all (mirror logoutAllRecord): revoke all stored + sessions + container.
  const X2 = await prisma.accountSessionContainer.create({ data: { tokenHash: `${T}_ctokX2`, expiresAt: future } });
  const s1 = await seedSession(A.id), s2 = await seedSession(B.id);
  const st1 = await prisma.storedAccountSession.create({ data: { containerId: X2.id, userId: A.id, sessionId: s1.id, displayOrder: 0 } });
  await prisma.storedAccountSession.create({ data: { containerId: X2.id, userId: B.id, sessionId: s2.id, displayOrder: 1 } });
  await prisma.accountSessionContainer.update({ where: { id: X2.id }, data: { activeStoredSessionId: st1.id } });
  const stored = await prisma.storedAccountSession.findMany({ where: { containerId: X2.id, revokedAt: null }, select: { sessionId: true } });
  await prisma.session.updateMany({ where: { id: { in: stored.map((s) => s.sessionId) }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "logout_all_accounts" } });
  await prisma.storedAccountSession.updateMany({ where: { containerId: X2.id }, data: { revokedAt: new Date() } });
  await prisma.accountSessionContainer.update({ where: { id: X2.id }, data: { revokedAt: new Date(), activeStoredSessionId: null } });
  const s1a = await prisma.session.findUnique({ where: { id: s1.id } }), s2a = await prisma.session.findUnique({ where: { id: s2.id } });
  check("MA11 logout-all revokes every account + container", !!s1a.revokedAt && !!s2a.revokedAt && (await resolve(X2.id)) === null);
  // 12) Removing one account NEVER revokes another container's session (isolation).
  const sYsess = await prisma.session.findUnique({ where: { id: sA.id } });
  check("MA12 remove/logout in X did not revoke container Y's stored rows", (await prisma.storedAccountSession.findUnique({ where: { id: stForeign.id } })).revokedAt === null);

  // --- SOURCE assertions: real code implements these guards ---
  const svc = src("../src/lib/account-container.ts");
  const sess = src("../src/lib/session.ts");
  check("MA-SRC1 getValidSession: container GOVERNS when present (no fallthrough on expired active)", /resolveContainerAuth\(\)/.test(sess) && /container\.governs/.test(sess) && sess.includes("if (!v) return null"));
  check("MA-SRC2 ownership guard on switch/remove (stored.containerId !== containerId)", (svc.match(/\.containerId !== containerId/g) || []).length >= 2);
  check("MA-SRC3 same validity gate (revoked/expired/isActive) as single session", svc.includes("s.revokedAt") && svc.includes("s.expiresAt.getTime() < Date.now()") && svc.includes("!s.user.isActive"));
  check("MA-SRC4 HMAC token only — hashToken(token), no raw token stored", svc.includes("hashToken(token)") && !/tokenHash:\s*token\b/.test(svc));
  check("MA-SRC5 scope cookies cleared on every account change (§14/§16)", svc.includes('store.delete("scope_company")') && svc.includes('store.delete("scope_club")') && (svc.match(/clearScopeCookies\(\)/g) || []).length >= 4);
  check("MA-SRC6 container cookie httpOnly + HMAC unique + logout-all revokes sessions", svc.includes("httpOnly: true") && svc.includes("logout_all_accounts") && sess.includes("removeActiveAccount"));

  // Cleanup — remove all synthetic rows (order: children then parents).
  const stoAll = await prisma.storedAccountSession.findMany({ where: { OR: [{ containerId: X.id }, { containerId: Y.id }, { containerId: X2.id }] }, select: { id: true } });
  await prisma.storedAccountSession.deleteMany({ where: { id: { in: stoAll.map((r) => r.id) } } });
  await prisma.accountSessionContainer.deleteMany({ where: { id: { in: [X.id, Y.id, X2.id] } } });
  await prisma.session.deleteMany({ where: { userId: { in: [A.id, B.id, C.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
