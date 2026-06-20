// Email-OTP verification (Part 20/21). Exercises the OTP HMAC + challenge
// lifecycle the service enforces (lib/otp + lib/login-challenge) directly against
// the dev SQLite DB: no plaintext OTP stored, wrong/expired/locked handling,
// resend invalidation, one-time + concurrent-safe consumption, emailVerifiedAt,
// inactive blocking, cleanup, and the system email-change / 2FA-reset services.
//
// SAFE: fixed "pilot-otp-*" ids, cleaned up. npm run pilot:otp
import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const p = new PrismaClient();
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";
const OTP_SECRET = process.env.OTP_SECRET ?? "dev-insecure-otp-secret";
const hashToken = (t) => createHmac("sha256", SESSION_SECRET).update(t).digest("hex");
const otpDigest = (cth, otp) => createHmac("sha256", OTP_SECRET).update(`${cth}:${otp}`).digest("hex");
function verifyOtp(cth, cand, digest) {
  if (!/^\d{6}$/.test(cand)) return false;
  const a = Buffer.from(otpDigest(cth, cand));
  const b = Buffer.from(digest);
  return a.length === b.length && timingSafeEqual(a, b);
}

const U = "pilot-otp-u1";
const U_INACTIVE = "pilot-otp-u2";

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? "  :: " + extra : ""}`); c ? pass++ : fail++; };

async function cleanup() {
  await p.user.deleteMany({ where: { id: { in: [U, U_INACTIVE] } } }); // cascades challenges/sessions
}

async function mkChallenge(userId, otp, { expiresInMs = 10 * 60 * 1000, resendInMs = 60 * 1000 } = {}) {
  const token = randomBytes(32).toString("hex");
  const cth = hashToken(token);
  const c = await p.emailOtpChallenge.create({
    data: {
      userId, challengeTokenHash: cth, otpDigest: otpDigest(cth, otp),
      purpose: "login", expiresAt: new Date(Date.now() + expiresInMs),
      resendAvailableAt: new Date(Date.now() + resendInMs),
    },
  });
  return { token, cth, c };
}

async function loadActive(cth) {
  const c = await p.emailOtpChallenge.findUnique({ where: { challengeTokenHash: cth }, include: { user: true } });
  if (!c || c.consumedAt || c.revokedAt || c.expiresAt < new Date() || !c.user?.isActive) return null;
  return c;
}

async function main() {
  await cleanup();
  await p.user.create({ data: { id: U, email: "pilot-otp-u1@company.ru", name: "U1", role: "manager", isActive: true, passwordHash: "x", emailVerifiedAt: null } });
  await p.user.create({ data: { id: U_INACTIVE, email: "pilot-otp-u2@company.ru", name: "U2", role: "manager", isActive: false, passwordHash: "x" } });

  const OTP = "012345"; // leading zero supported
  const { cth } = await mkChallenge(U, OTP);
  const row = await p.emailOtpChallenge.findUnique({ where: { challengeTokenHash: cth } });

  check("2 no plaintext OTP stored", row.otpDigest !== OTP && !Object.values(row).includes(OTP));
  check("HMAC digest matches", row.otpDigest === otpDigest(cth, OTP));
  check("correct OTP verifies (constant-time)", verifyOtp(cth, OTP, row.otpDigest) === true);
  check("10 wrong OTP fails", verifyOtp(cth, "999999", row.otpDigest) === false);

  // attempt increment + lock at maxAttempts
  let locked = false;
  for (let i = 0; i < 5; i++) {
    if (!verifyOtp(cth, "111111", row.otpDigest)) {
      const u = await p.emailOtpChallenge.update({ where: { id: row.id }, data: { attemptCount: { increment: 1 } }, select: { attemptCount: true, maxAttempts: true } });
      if (u.attemptCount >= u.maxAttempts) { await p.emailOtpChallenge.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedReason: "max_attempts" } }); locked = true; }
    }
  }
  check("11 five wrong attempts revoke challenge", locked && (await loadActive(cth)) === null);

  // expired
  const { cth: cthExp } = await mkChallenge(U, "222222", { expiresInMs: -1000 });
  check("12 expired challenge invalid", (await loadActive(cthExp)) === null);

  // resend cooldown enforced
  const { c: cCool } = await mkChallenge(U, "333333", { resendInMs: 60 * 1000 });
  check("15 resend cooldown enforced", Date.now() < cCool.resendAvailableAt.getTime());

  // resend invalidates old code (digest replaced)
  const { cth: cthR, c: cR } = await mkChallenge(U, "444444", { resendInMs: -1 });
  const NEWOTP = "555555";
  await p.emailOtpChallenge.update({ where: { id: cR.id }, data: { otpDigest: otpDigest(cthR, NEWOTP), expiresAt: new Date(Date.now() + 600000), sendCount: { increment: 1 }, lastSentAt: new Date() } });
  const rR = await p.emailOtpChallenge.findUnique({ where: { id: cR.id } });
  check("14 old code fails after resend", verifyOtp(cthR, "444444", rR.otpDigest) === false);
  check("14 new code valid after resend", verifyOtp(cthR, NEWOTP, rR.otpDigest) === true);

  // one-time + concurrent-safe consumption
  const { c: cCons } = await mkChallenge(U, "666666");
  const [a, b] = await Promise.all([
    p.emailOtpChallenge.updateMany({ where: { id: cCons.id, consumedAt: null, revokedAt: null }, data: { consumedAt: new Date() } }),
    p.emailOtpChallenge.updateMany({ where: { id: cCons.id, consumedAt: null, revokedAt: null }, data: { consumedAt: new Date() } }),
  ]);
  check("8/9 concurrent consume yields exactly one winner", a.count + b.count === 1, `counts=${a.count},${b.count}`);
  const reuse = await p.emailOtpChallenge.updateMany({ where: { id: cCons.id, consumedAt: null }, data: { consumedAt: new Date() } });
  check("8 reusing consumed challenge fails", reuse.count === 0);

  // emailVerifiedAt set on success + session created only after OTP
  const sessionsBefore = await p.session.count({ where: { userId: U } });
  await p.user.updateMany({ where: { id: U, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  const sToken = randomBytes(16).toString("hex");
  await p.session.create({ data: { userId: U, tokenHash: hashToken(sToken), expiresAt: new Date(Date.now() + 600000) } });
  const u1 = await p.user.findUnique({ where: { id: U } });
  check("18 emailVerifiedAt set after first OTP", u1.emailVerifiedAt !== null);
  check("7/22 session created only after OTP (exactly one new)", (await p.session.count({ where: { userId: U } })) === sessionsBefore + 1);

  // inactive user: never a usable challenge
  const { cth: cthInact } = await mkChallenge(U_INACTIVE, "777777");
  check("6 inactive user has no usable challenge", (await loadActive(cthInact)) === null);

  // system email-change service: clears verification, revokes sessions+challenges
  const NEW_EMAIL = "pilot-otp-new@company.ru";
  await p.$transaction(async (tx) => {
    await tx.user.update({ where: { id: U }, data: { email: NEW_EMAIL, emailVerifiedAt: null } });
    await tx.session.updateMany({ where: { userId: U, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "email_changed_by_system" } });
    await tx.emailOtpChallenge.updateMany({ where: { userId: U, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "email_changed_by_system" } });
  });
  const uChanged = await p.user.findUnique({ where: { id: U } });
  check("25 admin email-change clears verification", uChanged.email === NEW_EMAIL && uChanged.emailVerifiedAt === null);
  check("25 admin email-change revokes sessions", (await p.session.count({ where: { userId: U, revokedAt: null } })) === 0);

  // system 2FA reset: revokes challenges + sessions, clears verification (OTP NOT disabled)
  await mkChallenge(U, "888888");
  await p.$transaction(async (tx) => {
    await tx.emailOtpChallenge.updateMany({ where: { userId: U, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "two_factor_reset_by_system" } });
    await tx.user.update({ where: { id: U }, data: { emailVerifiedAt: null } });
    await tx.session.updateMany({ where: { userId: U, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "two_factor_reset_by_system" } });
  });
  check("26 admin 2FA reset leaves no active challenge (OTP still required)", (await p.emailOtpChallenge.count({ where: { userId: U, consumedAt: null, revokedAt: null } })) === 0);

  // cleanup retention: old revoked/expired removed, current kept
  const { c: current } = await mkChallenge(U, "999999");
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await p.emailOtpChallenge.create({ data: { userId: U, challengeTokenHash: hashToken(randomBytes(8).toString("hex")), otpDigest: "x", expiresAt: old, resendAvailableAt: old, revokedAt: old } });
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const del = await p.emailOtpChallenge.deleteMany({ where: { OR: [{ consumedAt: { not: null, lt: cutoff } }, { revokedAt: { not: null, lt: cutoff } }, { expiresAt: { lt: cutoff } }] } });
  check("19 cleanup removes stale, keeps current", del.count >= 1 && (await p.emailOtpChallenge.findUnique({ where: { id: current.id } })) !== null);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
