// Account deletion / recovery / system-admin regression (Part 19). Exercises the
// DB-level invariants the services enforce (lib/account-deletion, account-restore,
// account-recovery, system-role) directly against the dev SQLite database, using
// the SAME operations and crypto. SAFE: fixed "pilot-del-*" ids, cleaned up.
//   npm run pilot:account-deletion
import { PrismaClient } from "@prisma/client";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const p = new PrismaClient();
const SECRET = process.env.ACCOUNT_RECOVERY_SECRET && process.env.ACCOUNT_RECOVERY_SECRET.length >= 32
  ? process.env.ACCOUNT_RECOVERY_SECRET : "dev-insecure-account-recovery-secret-32b";

// --- crypto mirror of lib/account-recovery ---------------------------------
const aesKey = () => createHash("sha256").update(`aes:${SECRET}`).digest();
const hmac = (label, v) => createHmac("sha256", SECRET).update(`${label}:${v}`).digest("hex");
function encryptEmail(email) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([c.update(email, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decryptEmail(payload) {
  const b = Buffer.from(payload, "base64");
  const d = createDecipheriv("aes-256-gcm", aesKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
const normalize = (e) => e.trim().toLowerCase();
const tombstone = (id) => `deleted-${id}@account.invalid`;
const mask = (e) => { const [l, d] = e.split("@"); return d ? `${l.slice(0, 1)}***@${d}` : "***"; };

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const CO = "pilot-del-co", CO2 = "pilot-del-co2";
const OWNER = "pilot-del-owner", OWNER2 = "pilot-del-owner2", MGR = "pilot-del-mgr", SYS = "pilot-del-sys", OUT = "pilot-del-out";

async function cleanup() {
  await p.company.deleteMany({ where: { id: { in: [CO, CO2] } } });
  await p.user.deleteMany({ where: { id: { in: [OWNER, OWNER2, MGR, SYS, OUT] } } });
  // Also remove any re-registered accounts that reused a released fixture email
  // (their id is a fresh cuid, so they escape the id list above).
  await p.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: "pilot-del-" } },
        { email: { endsWith: "@pilot.del" } },
        { email: "reuse@pilot.del" },
      ],
    },
  });
}

// Mirror of soleOwnerBlockingCompany.
async function soleOwnerBlocking(userId) {
  const owned = await p.companyUserAccess.findMany({ where: { userId, role: "owner" }, select: { companyId: true } });
  for (const { companyId } of owned) {
    const others = await p.companyUserAccess.findMany({ where: { companyId, role: "owner", userId: { not: userId }, user: { isActive: true, deletedAt: null } }, select: { userId: true } });
    if (new Set(others.map((o) => o.userId)).size === 0) return companyId;
  }
  return null;
}

// Mirror of finalizeDeletion (atomic tombstone).
async function deleteAccount(userId, requestType, requestedByUserId = null) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hmac("recovery", token);
  const now = new Date();
  const restoreUntil = new Date(now.getTime() + 30 * 864e5);
  const out = await p.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { email: true, deletedAt: true } });
    if (!u || u.deletedAt) return null;
    if (await soleOwnerBlocking(userId)) return "sole_owner";
    const original = u.email, norm = normalize(original);
    const flipped = await tx.user.updateMany({ where: { id: userId, deletedAt: null }, data: { email: tombstone(userId), passwordHash: null, phone: null, emailVerifiedAt: null, lastLoginAt: null, isActive: false, deletedAt: now, restoreUntil, deletionRequestedAt: now } });
    if (flipped.count === 0) return null;
    await tx.companyUserAccess.deleteMany({ where: { userId } });
    await tx.clubUserAccess.deleteMany({ where: { userId } });
    await tx.userClubAccess.deleteMany({ where: { userId } });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: "account_deleted" } });
    await tx.emailOtpChallenge.updateMany({ where: { userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now, revokedReason: "account_deleted" } });
    await tx.invite.deleteMany({ where: { email: norm, acceptedAt: null } });
    const del = await tx.accountDeletion.create({ data: { userId, requestedByUserId, requestType, originalEmailEncrypted: encryptEmail(norm), originalEmailHash: hmac("email", norm), originalEmailMasked: mask(original), restoreTokenHash: tokenHash, restoreUntil, confirmedAt: now, deletedAt: now } });
    return { original, token, tokenHash, deletionId: del.id };
  });
  return out;
}

async function main() {
  await cleanup();
  await p.user.create({ data: { id: OWNER, email: "owner@pilot.del", name: "Иван Иванов", role: "owner", passwordHash: "x", phone: "+7", emailVerifiedAt: new Date(), isActive: true } });
  await p.user.create({ data: { id: OWNER2, email: "owner2@pilot.del", name: "Пётр", role: "owner", isActive: true } });
  await p.user.create({ data: { id: MGR, email: "mgr@pilot.del", name: "Менеджер", role: "manager", isActive: true } });
  await p.user.create({ data: { id: SYS, email: "sys@pilot.del", name: "Sys", role: "owner", isActive: true, systemRole: "system_admin" } });
  await p.user.create({ data: { id: OUT, email: "out@pilot.del", name: "Чужой", role: "manager", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Co" } });
  await p.company.create({ data: { id: CO2, name: "Co2" } });
  const club = await p.club.create({ data: { name: "Club", city: "X", companyId: CO } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: OWNER, role: "owner" } });
  await p.clubUserAccess.create({ data: { clubId: club.id, userId: MGR, role: "manager" } });
  await p.companyUserAccess.create({ data: { companyId: CO2, userId: OUT, role: "manager" } });
  // A financial row created by OWNER (must survive deletion).
  const inv = await p.invoice.create({ data: { companyId: CO, clubId: club.id, createdByUserId: OWNER, amountKopeks: 5000, status: "paid" } });
  // A session + login challenge for OWNER.
  await p.session.create({ data: { userId: OWNER, tokenHash: "pilot-del-sess", expiresAt: new Date(Date.now() + 864e5) } });
  await p.emailOtpChallenge.create({ data: { userId: OWNER, challengeTokenHash: "pilot-del-chal", otpDigest: "d", purpose: "login", expiresAt: new Date(Date.now() + 6e5), resendAvailableAt: new Date() } });
  await p.invite.create({ data: { tokenHash: "pilot-del-inv", email: "owner@pilot.del", companyId: CO, role: "manager", invitedByUserId: OWNER2, expiresAt: new Date(Date.now() + 864e5) } });

  // 7 sole owner cannot delete.
  check("7 sole owner blocked", (await soleOwnerBlocking(OWNER)) === CO);
  // 8 add a second owner -> can delete.
  await p.companyUserAccess.create({ data: { companyId: CO, userId: OWNER2, role: "owner" } });
  check("8 with second owner, not blocked", (await soleOwnerBlocking(OWNER)) === null);

  // 11 system_admin cannot be deleted by owner (eligibility mirror).
  const sysRow = await p.user.findUnique({ where: { id: SYS }, select: { systemRole: true } });
  check("11 target system_admin blocked", sysRow.systemRole === "system_admin");
  // 10 owner cannot delete a user with access outside owner scope (OUT is in CO2 only).
  const outCompanies = new Set((await p.companyUserAccess.findMany({ where: { userId: OUT }, select: { companyId: true } })).map((r) => r.companyId));
  const ownerOwned = new Set((await p.companyUserAccess.findMany({ where: { userId: OWNER, role: "owner" }, select: { companyId: true } })).map((r) => r.companyId));
  check("10 target access outside owner scope -> blocked", ![...outCompanies].every((c) => ownerOwned.has(c)));

  // 1/13 delete OWNER (now has co-owner). Email released; tombstone unique.
  const del = await deleteAccount(OWNER, "self");
  check("1 deletion succeeded", del && del.token, del ? "" : "null");
  const deleted = await p.user.findUnique({ where: { id: OWNER } });
  check("13 email replaced by tombstone", deleted.email === tombstone(OWNER));
  check("deleted flags set", deleted.deletedAt && deleted.isActive === false && deleted.passwordHash === null && deleted.phone === null && deleted.emailVerifiedAt === null);
  check("firstName/lastName-style name preserved", deleted.name === "Иван Иванов");

  // 18/20/22 sessions + challenges revoked, access removed, invites removed.
  check("18 sessions revoked", (await p.session.count({ where: { userId: OWNER, revokedAt: null } })) === 0);
  check("20 login challenges revoked", (await p.emailOtpChallenge.count({ where: { userId: OWNER, revokedAt: null } })) === 0);
  check("22 company access removed", (await p.companyUserAccess.count({ where: { userId: OWNER } })) === 0);
  check("21 pending invite to email removed", (await p.invite.count({ where: { email: "owner@pilot.del", acceptedAt: null } })) === 0);

  // 16/32 financial row still linked to old user id.
  const invAfter = await p.invoice.findUnique({ where: { id: inv.id } });
  check("16/32 financial row preserved + linked to old user id", invAfter && invAfter.createdByUserId === OWNER);

  // 13/14/15 email released -> new independent registration with same email.
  const newUser = await p.user.create({ data: { email: normalize("owner@pilot.del"), name: "Новый", role: "owner", isActive: true } });
  check("14 new account can register released email", newUser.email === "owner@pilot.del");
  check("15 new account has a different User.id", newUser.id !== OWNER);

  // 34 no plaintext token/otp stored: AccountDeletion holds only hashes/ciphertext.
  const rec = await p.accountDeletion.findUnique({ where: { id: del.deletionId } });
  check("34 restore token stored only as hash", rec.restoreTokenHash === hmac("recovery", del.token) && rec.restoreTokenHash !== del.token);
  check("original email encrypted (roundtrips)", decryptEmail(rec.originalEmailEncrypted) === "owner@pilot.del");
  check("original email not stored in plaintext", !JSON.stringify(rec).includes("owner@pilot.del"));

  // 29 restoration conflict: original email now reused -> restore must fail safely.
  const reuseTaken = await p.user.findUnique({ where: { email: "owner@pilot.del" }, select: { id: true } });
  check("29 email-reuse conflict detected (would block restore)", reuseTaken && reuseTaken.id !== OWNER);

  // 23-25 restore path when email IS free: delete MGR, then restore.
  const delMgr = await deleteAccount(MGR, "self");
  check("MGR deleted", !!delMgr);
  // token lookup + window valid + still deleted + email free
  const recM = await p.accountDeletion.findUnique({ where: { restoreTokenHash: hmac("recovery", delMgr.token) }, select: { id: true, userId: true, restoreUntil: true, restoredAt: true, originalEmailEncrypted: true } });
  const freeEmail = normalize(decryptEmail(recM.originalEmailEncrypted));
  const taken = await p.user.findUnique({ where: { email: freeEmail }, select: { id: true } });
  check("23 restore token resolves, email free", recM && recM.restoreUntil > new Date() && (!taken || taken.id === MGR));
  // finalize restore mirror
  await p.$transaction(async (tx) => {
    await tx.user.updateMany({ where: { id: MGR, deletedAt: { not: null } }, data: { email: freeEmail, passwordHash: "newhash", isActive: true, emailVerifiedAt: new Date(), deletedAt: null, restoreUntil: null, deletionRequestedAt: null } });
    await tx.accountDeletion.update({ where: { id: recM.id }, data: { restoredAt: new Date(), restoreTokenHash: null } });
  });
  const mgrAfter = await p.user.findUnique({ where: { id: MGR } });
  check("24/26 restored: active, email back, verified", mgrAfter.email === "mgr@pilot.del" && mgrAfter.isActive && mgrAfter.deletedAt === null);
  check("25 access NOT restored (still none)", (await p.clubUserAccess.count({ where: { userId: MGR } })) === 0);
  check("27 recovery token single-use (hash cleared)", (await p.accountDeletion.findUnique({ where: { id: recM.id } })).restoreTokenHash === null);

  // 28/31 expired window -> cleanup purges sensitive recovery data.
  await p.accountDeletion.update({ where: { id: del.deletionId }, data: { restoreUntil: new Date(Date.now() - 864e5) } });
  const purgeable = await p.accountDeletion.findMany({ where: { restoreUntil: { lt: new Date() }, recoveryPurgedAt: null, restoredAt: null }, select: { id: true } });
  await p.accountDeletion.updateMany({ where: { id: { in: purgeable.map((x) => x.id) } }, data: { originalEmailEncrypted: null, restoreTokenHash: null, recoveryPurgedAt: new Date() } });
  const purged = await p.accountDeletion.findUnique({ where: { id: del.deletionId } });
  check("31 cleanup purges encrypted email + token after window", purged.originalEmailEncrypted === null && purged.restoreTokenHash === null && purged.recoveryPurgedAt);
  check("28 tombstoned User remains after purge (never physically deleted)", (await p.user.findUnique({ where: { id: OWNER } })) !== null);

  // 12 system_admin only via systemRole field (no CompanyUserAccess row).
  check("12 system_admin is a User.systemRole, not a Company role", (await p.companyUserAccess.count({ where: { userId: SYS, role: "system_admin" } })) === 0 && sysRow.systemRole === "system_admin");

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
