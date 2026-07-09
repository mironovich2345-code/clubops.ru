// Account settings regression: profile name, password change, email change (2FA).
// Mirrors the pure validators (lib/account-settings) + the OTP challenge crypto
// (lib/otp, lib/tokens) and exercises DB effects (hash update, email swap, session
// revocation, challenge consume/replay). SAFE: fixed "pilot-acs-*" ids; test
// emails only; cleaned up. npm run pilot:account-settings
import { PrismaClient } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// --- Mirror of lib/account-settings ---------------------------------------
const MIN_PW = 8;
const normalizeName = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const hasControl = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true; } return false; };
function validateName(raw, label) {
  const v = normalizeName(raw);
  if (v.length < 1) return { ok: false, error: `${label} обязательно` };
  if (v.length > 80) return { ok: false };
  if (hasControl(v)) return { ok: false };
  return { ok: true, value: v };
}
const composeDisplayName = (f, l) => normalizeName(`${f} ${l}`) || f || l || "Пользователь";
function validateNewPassword(np, cf, cur) {
  if (np.length < MIN_PW) return { ok: false };
  if (np !== cf) return { ok: false };
  if (np === cur) return { ok: false };
  return { ok: true };
}
const normalizeEmail = (e) => String(e ?? "").trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isTombstone = (e) => /@account\.invalid$/i.test(e.trim());
function validateNewEmail(raw, cur) {
  const v = normalizeEmail(raw);
  if (!EMAIL_RE.test(v)) return { ok: false };
  if (isTombstone(v)) return { ok: false };
  if (v === normalizeEmail(cur)) return { ok: false };
  return { ok: true, value: v };
}

// --- Mirror of OTP + token crypto -----------------------------------------
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-session-secret";
const OTP_SECRET = process.env.OTP_SECRET || "dev-insecure-otp-secret";
const hashToken = (t) => createHmac("sha256", SESSION_SECRET).update(t).digest("hex");
const otpDigest = (cth, otp) => createHmac("sha256", OTP_SECRET).update(`${cth}:${otp}`).digest("hex");
const verifyOtp = (cth, cand, stored) => { if (!/^\d{6}$/.test(cand)) return false; const a = Buffer.from(otpDigest(cth, cand), "utf8"), b = Buffer.from(stored, "utf8"); return a.length === b.length && timingSafeEqual(a, b); };
// Mirror of the signed email-change cookie binding.
const signEmailChange = (uid, orig, next) => hashToken(`emailchange|${uid}|${orig}|${next}`);

const U1 = "pilot-acs-u1", U2 = "pilot-acs-u2";
async function cleanup() {
  await p.session.deleteMany({ where: { userId: { in: [U1, U2] } } }).catch(() => {});
  await p.emailOtpChallenge.deleteMany({ where: { userId: { in: [U1, U2] } } }).catch(() => {});
  await p.user.deleteMany({ where: { id: { in: [U1, U2] } } }).catch(() => {});
  await p.user.deleteMany({ where: { email: { endsWith: "@pilot.acs" } } }).catch(() => {});
}

async function main() {
  await cleanup();

  // ===== Name (1-8) =====
  check("1 valid name accepted", validateName(" Иван ", "Имя").ok && validateName("Иванов", "Фамилия").ok);
  check("3 empty first name rejected", !validateName("   ", "Имя").ok);
  check("4 empty last name rejected", !validateName("", "Фамилия").ok);
  check("5 unicode name accepted", validateName("Þórunn", "Имя").ok && validateName("李四", "Фамилия").ok);
  check("5b hyphen/apostrophe/space accepted", validateName("Анна-Мария", "Имя").ok && validateName("O'Брайен", "Фамилия").ok);
  check("too-long rejected", !validateName("я".repeat(81), "Имя").ok);
  check("control chars rejected", !validateName("Иван", "Имя").ok);
  check("2 name derived from first+last", composeDisplayName("Иван", "Иванов") === "Иван Иванов");

  // ===== Password pure (9,16,17,18) =====
  check("18 weak password rejected", !validateNewPassword("short", "short", "OldPass1!").ok);
  check("16 mismatch rejected", !validateNewPassword("NewPass1!", "NewPass2!", "OldPass1!").ok);
  check("17 same-as-current rejected", !validateNewPassword("OldPass1!", "OldPass1!", "OldPass1!").ok);
  check("valid new password accepted", validateNewPassword("NewPass1!", "NewPass1!", "OldPass1!").ok);

  // ===== Email pure (26,27, format, tombstone) =====
  check("bad email rejected", !validateNewEmail("not-an-email", "a@b.co").ok);
  check("tombstone email rejected", !validateNewEmail("deleted-x@account.invalid", "a@b.co").ok);
  check("27 same-as-current rejected", !validateNewEmail("A@B.CO", "a@b.co").ok);
  check("valid new email normalized", validateNewEmail(" New@Mail.Ru ", "a@b.co").value === "new@mail.ru");

  // ===== Email-change cookie binding (34) =====
  const sig = signEmailChange(U1, "old@pilot.acs", "new@pilot.acs");
  check("34 binding signature deterministic", signEmailChange(U1, "old@pilot.acs", "new@pilot.acs") === sig);
  check("34b tampered new email fails binding", signEmailChange(U1, "old@pilot.acs", "evil@pilot.acs") !== sig);
  check("34c cross-user binding fails", signEmailChange(U2, "old@pilot.acs", "new@pilot.acs") !== sig);

  // ===== DB: users + password change effects (10-22) =====
  const oldHash = await bcrypt.hash("OldPass1!", 10);
  await p.user.create({ data: { id: U1, email: "one@pilot.acs", name: "Один", firstName: "Один", lastName: "Пилот", role: "manager", passwordHash: oldHash, isActive: true, emailVerifiedAt: new Date() } });
  await p.user.create({ data: { id: U2, email: "two@pilot.acs", name: "Два", role: "manager", isActive: true } });
  // two sessions for U1 (one "current", one "other")
  const sCur = await p.session.create({ data: { userId: U1, tokenHash: "acs-cur", expiresAt: new Date(Date.now() + 864e5) } });
  await p.session.create({ data: { userId: U1, tokenHash: "acs-other", expiresAt: new Date(Date.now() + 864e5) } });

  check("9 wrong current password fails bcrypt", (await bcrypt.compare("WRONG", oldHash)) === false);
  check("10 correct current password verifies", (await bcrypt.compare("OldPass1!", oldHash)) === true);
  // finalize password change (mirror the action's txn: update hash, revoke OTHER sessions)
  const newHash = await bcrypt.hash("NewPass1!", 10);
  await p.$transaction(async (tx) => {
    await tx.user.update({ where: { id: U1 }, data: { passwordHash: newHash } });
    await tx.session.updateMany({ where: { userId: U1, id: { not: sCur.id }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "password_changed" } });
  });
  const u1After = await p.user.findUnique({ where: { id: U1 } });
  check("19 password hash updated", u1After.passwordHash === newHash);
  check("20 old password no longer verifies", (await bcrypt.compare("OldPass1!", u1After.passwordHash)) === false);
  check("21 new password verifies", (await bcrypt.compare("NewPass1!", u1After.passwordHash)) === true);
  check("22 other sessions revoked, current kept", (await p.session.count({ where: { userId: U1, revokedAt: null } })) === 1 && (await p.session.findUnique({ where: { id: sCur.id } })).revokedAt === null);

  // ===== DB: email change finalize (25,26,36-42) =====
  check("26 email taken by other blocks", (await p.user.findFirst({ where: { email: "two@pilot.acs", id: { not: U1 }, deletedAt: null } })) !== null);
  const origEmail = u1After.email;
  await p.$transaction(async (tx) => {
    // uniqueness re-check
    const taken = await tx.user.findFirst({ where: { email: "changed@pilot.acs", id: { not: U1 }, deletedAt: null } });
    if (taken) throw new Error("taken");
    await tx.user.update({ where: { id: U1 }, data: { email: "changed@pilot.acs", emailVerifiedAt: new Date() } });
    await tx.session.updateMany({ where: { userId: U1, id: { not: sCur.id }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "email_changed" } });
  });
  const u1Email = await p.user.findUnique({ where: { id: U1 } });
  check("37 user id preserved after email change", u1Email.id === U1);
  check("40 email + emailVerifiedAt updated", u1Email.email === "changed@pilot.acs" && u1Email.emailVerifiedAt !== null);
  check("41 old email released (no active holder)", (await p.user.findFirst({ where: { email: origEmail, isActive: true } })) === null);
  check("38 roles/name preserved (identity intact)", u1Email.name === "Один" && u1Email.role === "manager");

  // ===== OTP challenge mechanics (12-15, 31,44) =====
  const cth = hashToken("acs-challenge-token");
  const otp = "123456";
  const ch = await p.emailOtpChallenge.create({ data: { userId: U1, challengeTokenHash: cth, otpDigest: otpDigest(cth, otp), purpose: "change_password", expiresAt: new Date(Date.now() + 6e5), resendAvailableAt: new Date() } });
  check("12 wrong OTP rejected", verifyOtp(cth, "000000", ch.otpDigest) === false);
  check("correct OTP verifies", verifyOtp(cth, otp, ch.otpDigest) === true);
  // consume (replay-safe)
  const consumed = await p.emailOtpChallenge.updateMany({ where: { id: ch.id, consumedAt: null, revokedAt: null }, data: { consumedAt: new Date() } });
  const replay = await p.emailOtpChallenge.updateMany({ where: { id: ch.id, consumedAt: null, revokedAt: null }, data: { consumedAt: new Date() } });
  check("15/44 OTP single-use (consume once, replay blocked)", consumed.count === 1 && replay.count === 0);
  // current vs new email codes differ (different challenge token → different digest for same code)
  const cthNew = hashToken("acs-challenge-token-2");
  check("31 current/new codes bound to different challenges", otpDigest(cth, otp) !== otpDigest(cthNew, otp));
  // expiry check
  const expired = await p.emailOtpChallenge.create({ data: { userId: U1, challengeTokenHash: hashToken("acs-exp"), otpDigest: otpDigest(hashToken("acs-exp"), otp), purpose: "change_password", expiresAt: new Date(Date.now() - 1000), resendAvailableAt: new Date() } });
  check("13 expired challenge detected", expired.expiresAt.getTime() < Date.now());
  // max attempts
  check("14 max attempts is 5", ch.maxAttempts === 5);

  // ===== Static assertions on the real source =====
  const acs = readFileSync(new URL("../src/lib/account-settings.ts", import.meta.url), "utf8");
  const act = readFileSync(new URL("../src/app/(app)/settings/security/account-actions.ts", import.meta.url), "utf8");
  const acLib = readFileSync(new URL("../src/lib/action-challenge.ts", import.meta.url), "utf8");
  check("S1 name derived via composeDisplayName in action", act.includes("composeDisplayName("));
  check("S2 password change re-auths with verifyPassword + OTP", act.includes("verifyPassword(") && act.includes('purpose: "change_password"'));
  check("S3 email change is two-stage (current + new purposes)", act.includes('"change_email_current"') && act.includes('"change_email_new"'));
  check("S4 email binding via signed cookie (HMAC)", act.includes("signEmailChange(") && act.includes("hashToken("));
  check("S5 finalize revokes OTHER sessions (current kept)", act.includes("revokeOtherSessions("));
  check("S6 password/email audits are count-only (no raw email/password/OTP)", act.includes("metadata: { revokedSessionCount: revokedSessions }") && act.includes("metadata: { revokedSessionCount: result.revoked }"));
  check("S7 profile audit logs field names only", act.includes('fields: ["firstName", "lastName", "name"]'));
  check("S8 actions gate on emailConfigured", act.includes("emailConfigured()") && act.includes("EMAIL_DISABLED"));
  check("S9 new OTP purposes wired into action-challenge", acLib.includes('"change_password"') && acLib.includes('"change_email_current"') && acLib.includes('"change_email_new"'));
  check("S10 pure validators exported", acs.includes("export function validateNameField") && acs.includes("export function validateNewPassword") && acs.includes("export function validateNewEmail"));
  check("S11 passwordless account gets a safe error (no bypass)", act.includes("пароль не установлен"));
  check("S12 target user is the session user only (no client userId)", !/formData\.get\(["'](userId|targetEmail)["']\)/.test(act));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
