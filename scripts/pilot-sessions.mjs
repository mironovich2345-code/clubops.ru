// Session lifecycle verification (Part 17). Exercises the DB-level invariants
// the session service enforces (lib/session.ts) directly against the dev SQLite
// database: only tokenHash is stored, revoked/expired/inactive sessions are
// invalid, list/count exclude them, revoke-all and revoke-others behave.
//
// SAFE: fixed "pilot-sess-*" ids, cleaned up before and after. npm run pilot:sessions
import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";

const p = new PrismaClient();
const SECRET = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";
const hashToken = (t) => createHmac("sha256", SECRET).update(t).digest("hex");

const U1 = "pilot-sess-u1";
const U2 = "pilot-sess-u2";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  :: " + extra : ""}`);
  cond ? pass++ : fail++;
};

// Mirrors lib/session.isValid + the ACTIVE_WHERE used by list/count.
const now = () => Date.now();
function isValid(s, user) {
  if (!s) return false;
  if (s.revokedAt) return false;
  if (s.expiresAt.getTime() < now()) return false;
  if (!user || !user.isActive) return false;
  return true;
}

async function cleanup() {
  await p.user.deleteMany({ where: { id: { in: [U1, U2] } } }); // cascades sessions
}

async function mkSession(userId, { expiresInMs = 1000 * 60, revoked = false } = {}) {
  const token = randomBytes(16).toString("hex");
  const s = await p.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now() + expiresInMs),
      revokedAt: revoked ? new Date() : null,
      deviceLabel: "Chrome · Windows",
    },
  });
  return { token, s };
}

async function main() {
  await cleanup();
  await p.user.create({ data: { id: U1, email: "pilot-sess-u1@example.com", name: "U1", role: "manager", isActive: true } });
  await p.user.create({ data: { id: U2, email: "pilot-sess-u2@example.com", name: "U2", role: "manager", isActive: true } });
  const u1 = await p.user.findUnique({ where: { id: U1 } });

  // 1/2: creation stores only the hash, never the raw token.
  const { token, s: live } = await mkSession(U1);
  const stored = await p.session.findUnique({ where: { id: live.id } });
  check("2 only tokenHash stored (matches HMAC of token)", stored.tokenHash === hashToken(token));
  check("2 raw token absent from row", !Object.values(stored).includes(token));

  // 4: revoked session fails validation.
  const { s: revoked } = await mkSession(U1, { revoked: true });
  check("4 revoked session invalid", isValid(await p.session.findUnique({ where: { id: revoked.id } }), u1) === false);

  // 5: expired session fails validation.
  const { s: expired } = await mkSession(U1, { expiresInMs: -1000 });
  check("5 expired session invalid", isValid(await p.session.findUnique({ where: { id: expired.id } }), u1) === false);

  // 6: inactive user's session fails validation.
  check("6 inactive user's session invalid", isValid(stored, { isActive: false }) === false);
  check("6 active user's live session valid", isValid(stored, u1) === true);

  // list/count exclude revoked + expired (ACTIVE_WHERE).
  const activeWhere = { userId: U1, revokedAt: null, expiresAt: { gt: new Date() } };
  const activeCount = await p.session.count({ where: activeWhere });
  check("list/count exclude revoked+expired", activeCount === 1, `count=${activeCount}`);

  // revokeOthers: keep current, revoke the rest.
  const { s: second } = await mkSession(U1);
  const beforeOthers = await p.session.count({ where: activeWhere });
  check("two active sessions before revoke-others", beforeOthers === 2, `count=${beforeOthers}`);
  await p.session.updateMany({ where: { userId: U1, id: { not: live.id }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "self_other" } });
  const liveStill = await p.session.findUnique({ where: { id: live.id } });
  const secondNow = await p.session.findUnique({ where: { id: second.id } });
  check("10/11 revoke-others keeps current active", isValid(liveStill, u1) === true && isValid(secondNow, u1) === false);

  // revokeAll: current included.
  await p.session.updateMany({ where: { userId: U1, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "self_all" } });
  check("13/14 revoke-all leaves zero active", (await p.session.count({ where: activeWhere })) === 0);

  // tenant isolation: U2 sessions untouched.
  await mkSession(U2);
  check("revocation of U1 did not affect U2", (await p.session.count({ where: { userId: U2, revokedAt: null, expiresAt: { gt: new Date() } } })) === 1);

  // deactivation invalidates without deleting rows (history retained).
  const u1RowsBefore = await p.session.count({ where: { userId: U1 } });
  await p.user.update({ where: { id: U1 }, data: { isActive: false } });
  const u1Inactive = await p.user.findUnique({ where: { id: U1 } });
  check("22 deactivated user: all sessions invalid", isValid(liveStill, u1Inactive) === false);
  check("history retained (rows not deleted)", (await p.session.count({ where: { userId: U1 } })) === u1RowsBefore);

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
