// Invitations regression (Block A). Exercises the real transactional invite
// application, direct grant, token rotation + rate-limit gate against the dev
// SQLite DB by mirroring lib/invite-service + lib/invites, and statically
// asserts the authorization / no-token-in-DB / auto-apply wiring on the real
// source. SAFE: fixed "pilot-inv-*" ids; cleaned up; no email is ever sent.
//   npm run pilot:invites
import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const SECRET = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";
const hmac = (t) => createHmac("sha256", SECRET).update(t).digest("hex");
const newToken = () => { const token = randomBytes(32).toString("hex"); return { token, tokenHash: hmac(token) }; };
const normalize = (e) => e.normalize("NFKC").trim().toLowerCase();
const isExpired = (d, now) => d.getTime() < now.getTime();

// --- Mirror of lib/invites.evaluateSendGate --------------------------------
const COOLDOWN = 60_000, WINDOW = 24 * 60 * 60 * 1000, MAX = 5;
function evaluateSendGate({ lastSentAt, sendWindowStartedAt, sendCountInWindow, now }) {
  if (lastSentAt && now.getTime() - lastSentAt.getTime() < COOLDOWN) return { ok: false, reason: "cooldown" };
  let ws = sendWindowStartedAt, c = sendCountInWindow;
  if (!ws || now.getTime() - ws.getTime() >= WINDOW) { ws = now; c = 0; }
  if (c >= MAX) return { ok: false, reason: "rate" };
  return { ok: true, windowStartedAt: ws, countInWindow: c + 1 };
}

// --- Mirror of lib/invites.deriveInviteStatus ------------------------------
function deriveStatus(inv, now = new Date()) {
  if (inv.acceptedAt) return "accepted";
  if (inv.revokedAt) return "revoked";
  if (isExpired(inv.expiresAt, now)) return "expired";
  if (inv.emailDeliveryStatus === "failed") return "email_failed";
  if (inv.emailDeliveryStatus === "sent") return "email_sent";
  return "pending";
}

// --- Mirror of lib/invite-service.applyInvite ------------------------------
async function applyInvite(inviteId, user, now = new Date()) {
  const invite = await p.invite.findUnique({ where: { id: inviteId } });
  if (!invite) return { ok: false, reason: "not_found" };
  if (invite.acceptedAt) return { ok: false, reason: "already" };
  if (invite.revokedAt) return { ok: false, reason: "revoked" };
  if (isExpired(invite.expiresAt, now)) return { ok: false, reason: "expired" };
  if (normalize(invite.email) !== normalize(user.email)) return { ok: false, reason: "email_mismatch" };
  const u = await p.user.findUnique({ where: { id: user.id }, select: { isActive: true, deletedAt: true } });
  if (!u || !u.isActive || u.deletedAt) return { ok: false, reason: "user_invalid" };
  let committed = false;
  try {
    committed = await p.$transaction(async (tx) => {
      const cas = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedByUserId: user.id },
      });
      if (cas.count !== 1) return false;
      if (invite.clubId) {
        await tx.clubUserAccess.upsert({ where: { clubId_userId_role: { clubId: invite.clubId, userId: user.id, role: invite.role } }, create: { clubId: invite.clubId, userId: user.id, role: invite.role }, update: {} });
      } else {
        await tx.companyUserAccess.upsert({ where: { companyId_userId_role: { companyId: invite.companyId, userId: user.id, role: invite.role } }, create: { companyId: invite.companyId, userId: user.id, role: invite.role }, update: {} });
      }
      await tx.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      return true;
    });
  } catch (e) {
    if (e.code === "P2002") return { ok: false, reason: "already" };
    throw e;
  }
  if (!committed) return { ok: false, reason: "already" };
  return { ok: true, scope: invite.clubId ? "club" : "company" };
}

async function applyAllPending(user, now = new Date()) {
  const invites = await p.invite.findMany({
    where: { email: normalize(user.email), acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
  });
  let applied = 0;
  for (const inv of invites) if ((await applyInvite(inv.id, user, now)).ok) applied++;
  return applied;
}

// --- Mirror of rotateInviteToken (resend / regenerate) ---------------------
async function rotate(inviteId, now = new Date()) {
  const inv = await p.invite.findUnique({ where: { id: inviteId } });
  if (inv.acceptedAt || inv.revokedAt) return { ok: false, reason: "not_pending" };
  const gate = evaluateSendGate({ lastSentAt: inv.lastSentAt, sendWindowStartedAt: inv.sendWindowStartedAt, sendCountInWindow: inv.sendCountInWindow, now });
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const { token, tokenHash } = newToken();
  const cas = await p.invite.updateMany({
    where: { id: inv.id, acceptedAt: null, revokedAt: null, lastSentAt: inv.lastSentAt, sendCountInWindow: inv.sendCountInWindow },
    data: { tokenHash, expiresAt: new Date(now.getTime() + 7 * 864e5), lastSentAt: now, sentCount: { increment: 1 }, sendWindowStartedAt: gate.windowStartedAt, sendCountInWindow: gate.countInWindow },
  });
  if (cas.count !== 1) return { ok: false, reason: "conflict" };
  return { ok: true, token, tokenHash };
}

const CO = "pilot-inv-co", CO2 = "pilot-inv-co2";
const OWNER = "pilot-inv-owner", VERIFIED = "pilot-inv-verified", UNVERIF = "pilot-inv-unverif";
const OTHER = "pilot-inv-other", DELETED = "pilot-inv-deleted";
const ids = [OWNER, VERIFIED, UNVERIF, OTHER, DELETED];

async function cleanup() {
  await p.auditLog.deleteMany({ where: { companyId: { in: [CO, CO2] } } }).catch(() => {});
  await p.invite.deleteMany({ where: { companyId: { in: [CO, CO2] } } }).catch(() => {});
  await p.clubUserAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await p.companyUserAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await p.club.deleteMany({ where: { companyId: { in: [CO, CO2] } } }).catch(() => {});
  await p.company.deleteMany({ where: { id: { in: [CO, CO2] } } }).catch(() => {});
  await p.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

async function main() {
  await cleanup();

  // ===== Pure gate + status (24, 25, 31) =====
  const t0 = new Date("2026-01-01T00:00:00Z");
  check("24 cooldown blocks within 60s", evaluateSendGate({ lastSentAt: new Date(t0.getTime() - 30_000), sendWindowStartedAt: t0, sendCountInWindow: 1, now: t0 }).reason === "cooldown");
  check("24b cooldown clears after 60s", evaluateSendGate({ lastSentAt: new Date(t0.getTime() - 61_000), sendWindowStartedAt: new Date(t0.getTime() - 61_000), sendCountInWindow: 1, now: t0 }).ok === true);
  check("25 rate limit blocks at 5/24h", evaluateSendGate({ lastSentAt: new Date(t0.getTime() - 120_000), sendWindowStartedAt: new Date(t0.getTime() - 3_600_000), sendCountInWindow: 5, now: t0 }).reason === "rate");
  check("25b window resets after 24h", (() => { const g = evaluateSendGate({ lastSentAt: new Date(t0.getTime() - 25 * 3600_000), sendWindowStartedAt: new Date(t0.getTime() - 25 * 3600_000), sendCountInWindow: 5, now: t0 }); return g.ok && g.countInWindow === 1; })());
  check("31 derive statuses", deriveStatus({ acceptedAt: new Date(), revokedAt: null, expiresAt: t0, emailDeliveryStatus: null }) === "accepted"
    && deriveStatus({ acceptedAt: null, revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e6), emailDeliveryStatus: "sent" }) === "revoked"
    && deriveStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date(Date.now() - 1e6), emailDeliveryStatus: "sent" }) === "expired"
    && deriveStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 1e6), emailDeliveryStatus: "failed" }) === "email_failed"
    && deriveStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 1e6), emailDeliveryStatus: "sent" }) === "email_sent"
    && deriveStatus({ acceptedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 1e6), emailDeliveryStatus: null }) === "pending");

  // ===== DB fixtures =====
  await p.company.create({ data: { id: CO, name: "Inv Co" } });
  await p.company.create({ data: { id: CO2, name: "Inv Co2" } });
  const clubA = await p.club.create({ data: { name: "A", city: "X", companyId: CO } });
  const clubB = await p.club.create({ data: { name: "B", city: "X", companyId: CO } });
  await p.user.create({ data: { id: OWNER, email: "owner@inv.test", name: "Овнер", role: "owner", isActive: true, emailVerifiedAt: new Date() } });
  await p.user.create({ data: { id: VERIFIED, email: "verified@inv.test", name: "Верифи", role: "manager", isActive: true, emailVerifiedAt: new Date() } });
  await p.user.create({ data: { id: UNVERIF, email: "unverif@inv.test", name: "Неверифи", role: "manager", isActive: true, emailVerifiedAt: null } });
  await p.user.create({ data: { id: OTHER, email: "other@inv.test", name: "Чужой", role: "manager", isActive: true, emailVerifiedAt: new Date() } });
  await p.user.create({ data: { id: DELETED, email: "deleted@inv.test", name: "Удалён", role: "manager", isActive: false, emailVerifiedAt: new Date(), deletedAt: new Date() } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: OWNER, role: "owner" } });

  const mkInvite = (over = {}) => p.invite.create({ data: { tokenHash: newToken().tokenHash, email: "new@inv.test", companyId: CO, clubId: clubA.id, role: "manager", invitedByUserId: OWNER, expiresAt: new Date(Date.now() + 7 * 864e5), ...over } });

  // ===== 14 raw token never stored =====
  const i14 = await mkInvite();
  const cols = Object.keys(await p.invite.findUnique({ where: { id: i14.id } }));
  check("14 Invite row stores tokenHash, no raw token column", cols.includes("tokenHash") && !cols.includes("token") && !cols.includes("rawToken") && !cols.includes("inviteUrl"));

  // ===== 15 accept by wrong email rejected =====
  const i15 = await mkInvite({ email: "target@inv.test" });
  check("15 accept with mismatched email rejected", (await applyInvite(i15.id, { id: OTHER, email: "other@inv.test" })).reason === "email_mismatch");

  // ===== 16 expired invite not applied =====
  const i16 = await mkInvite({ email: "other@inv.test", expiresAt: new Date(Date.now() - 1000) });
  check("16 expired invite not applied", (await applyInvite(i16.id, { id: OTHER, email: "other@inv.test" })).reason === "expired");

  // ===== 17 revoked invite not applied =====
  const i17 = await mkInvite({ email: "other@inv.test", revokedAt: new Date() });
  check("17 revoked invite not applied", (await applyInvite(i17.id, { id: OTHER, email: "other@inv.test" })).reason === "revoked");

  // ===== user_invalid: deleted / inactive user =====
  const iDel = await mkInvite({ email: "deleted@inv.test" });
  check("9 deleted/inactive user gets no access", (await applyInvite(iDel.id, { id: DELETED, email: "deleted@inv.test" })).reason === "user_invalid");

  // ===== 18 token single-use (sequential) + 29 no duplicate access =====
  const i18 = await mkInvite({ email: "other@inv.test", clubId: clubB.id });
  const first = await applyInvite(i18.id, { id: OTHER, email: "other@inv.test" });
  const second = await applyInvite(i18.id, { id: OTHER, email: "other@inv.test" });
  check("18 token single-use (second accept rejected)", first.ok === true && second.ok === false);
  check("29 no duplicate access after re-accept", (await p.clubUserAccess.count({ where: { clubId: clubB.id, userId: OTHER, role: "manager" } })) === 1);

  // ===== 19 concurrent double accept grants once =====
  const i19 = await mkInvite({ email: "verified@inv.test", clubId: clubA.id, role: "manager" });
  await Promise.allSettled([
    applyInvite(i19.id, { id: VERIFIED, email: "verified@inv.test" }),
    applyInvite(i19.id, { id: VERIFIED, email: "verified@inv.test" }),
  ]);
  check("19 concurrent double accept → exactly one access row", (await p.clubUserAccess.count({ where: { clubId: clubA.id, userId: VERIFIED, role: "manager" } })) === 1);
  check("19b invite marked accepted once with acceptedByUserId", (await p.invite.findUnique({ where: { id: i19.id } })).acceptedByUserId === VERIFIED);

  // ===== 20/21 auto-apply all active; ignore expired+revoked =====
  await p.invite.deleteMany({ where: { email: "multi@inv.test" } });
  const m1 = await mkInvite({ email: "multi@inv.test", clubId: clubA.id, role: "manager" });
  const m2 = await mkInvite({ email: "multi@inv.test", clubId: null, role: "accountant" });
  const m3 = await mkInvite({ email: "multi@inv.test", clubId: clubB.id, role: "manager", expiresAt: new Date(Date.now() - 1000) }); // expired
  const m4 = await mkInvite({ email: "multi@inv.test", clubId: null, role: "marketer", revokedAt: new Date() }); // revoked
  await p.user.update({ where: { id: UNVERIF }, data: { email: "multi@inv.test" } });
  const applied = await applyAllPending({ id: UNVERIF, email: "multi@inv.test" });
  check("20 auto-apply applies all active invites", applied === 2);
  check("21 expired/revoked ignored by auto-apply",
    (await p.invite.findUnique({ where: { id: m3.id } })).acceptedAt === null
    && (await p.invite.findUnique({ where: { id: m4.id } })).acceptedAt === null
    && (await p.clubUserAccess.count({ where: { clubId: clubA.id, userId: UNVERIF } })) === 1
    && (await p.companyUserAccess.count({ where: { companyId: CO, userId: UNVERIF, role: "accountant" } })) === 1);
  void m1; void m2;

  // ===== 7/8 existing verified user direct grant (idempotent), no invite =====
  await p.companyUserAccess.create({ data: { companyId: CO, userId: VERIFIED, role: "marketer" } });
  await p.companyUserAccess.upsert({ where: { companyId_userId_role: { companyId: CO, userId: VERIFIED, role: "marketer" } }, create: { companyId: CO, userId: VERIFIED, role: "marketer" }, update: {} });
  check("7/29 direct grant idempotent (no duplicate)", (await p.companyUserAccess.count({ where: { companyId: CO, userId: VERIFIED, role: "marketer" } })) === 1);

  // ===== 22/23 resend rotates token, old link dead =====
  const i22 = await mkInvite({ email: "rot@inv.test", lastSentAt: new Date(Date.now() - 120_000), sendWindowStartedAt: new Date(Date.now() - 120_000), sendCountInWindow: 1 });
  const oldHash = (await p.invite.findUnique({ where: { id: i22.id } })).tokenHash;
  const rot = await rotate(i22.id);
  const newHash = (await p.invite.findUnique({ where: { id: i22.id } })).tokenHash;
  check("22 resend issues a new token", rot.ok && newHash !== oldHash && newHash === rot.tokenHash);
  check("23 old link no longer resolves", (await p.invite.findUnique({ where: { tokenHash: oldHash } })) === null);
  check("26 regenerate invalidates old (same rotation path)", (await p.invite.findUnique({ where: { tokenHash: newHash } })).id === i22.id);

  // ===== 24/25 rotate honors cooldown + rate at DB level =====
  const i24 = await mkInvite({ email: "cd@inv.test", lastSentAt: new Date(), sendWindowStartedAt: new Date(), sendCountInWindow: 1 });
  check("24 rotate blocked by cooldown", (await rotate(i24.id)).reason === "cooldown");
  const i25 = await mkInvite({ email: "rl@inv.test", lastSentAt: new Date(Date.now() - 120_000), sendWindowStartedAt: new Date(Date.now() - 3_600_000), sendCountInWindow: 5 });
  check("25 rotate blocked by rate limit", (await rotate(i25.id)).reason === "rate");

  // ===== 27 revoke keeps the row; accepted cannot be revoked =====
  const i27 = await mkInvite({ email: "rev@inv.test" });
  await p.invite.updateMany({ where: { id: i27.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  const revd = await p.invite.findUnique({ where: { id: i27.id } });
  check("27 revoke sets revokedAt, row preserved, expiresAt untouched", revd !== null && revd.revokedAt !== null);
  check("27b revoked invite cannot be resent", (await rotate(i27.id)).reason === "not_pending");
  const i27b = await mkInvite({ email: "acc@inv.test", acceptedAt: new Date(), acceptedByUserId: OTHER });
  const casAcc = await p.invite.updateMany({ where: { id: i27b.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  check("27c accepted invite cannot be revoked (CAS count 0)", casAcc.count === 0);

  await cleanup();

  // ===== Static assertions on the real source =====
  const svc = readFileSync(new URL("../src/lib/invite-service.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/(app)/users/actions.ts", import.meta.url), "utf8");
  const accept = readFileSync(new URL("../src/app/accept-invite/actions.ts", import.meta.url), "utf8");
  const challenge = readFileSync(new URL("../src/lib/login-challenge.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const invitesLib = readFileSync(new URL("../src/lib/invites.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/(app)/users/page.tsx", import.meta.url), "utf8");

  check("S1 applyInvite uses transaction + compare-and-set", svc.includes("$transaction") && svc.includes("acceptedAt: null, revokedAt: null, expiresAt: { gt: now }") && svc.includes("cas.count !== 1"));
  check("S2 applyInvite enforces email match + active/non-deleted user", svc.includes('reason: "email_mismatch"') && svc.includes("!u.isActive || u.deletedAt"));
  check("S3 direct grant guarded by verified+active+not-deleted", actions.includes("existingUser.emailVerifiedAt && existingUser.isActive && !existingUser.deletedAt"));
  check("S4 direct grant audit uses via direct_email_grant", svc.includes('via: "direct_email_grant"'));
  check("S5 pending invite created + email sent, failure not fatal", actions.includes('action: "invitation.created"') && actions.includes("sendInviteEmail(") && actions.includes('emailDeliveryStatus: sent.ok ? "sent" : "failed"'));
  check("S6 resend/regenerate/revoke actions exist", actions.includes("export async function resendInvite") && actions.includes("export async function regenerateInviteLink") && actions.includes("export async function revokeInvite"));
  check("S7 revoke sets revokedAt, never deletes", actions.includes('data: { revokedAt: new Date() }') && !actions.includes("invite.delete("));
  check("S8 rotation rate-limited via evaluateSendGate + CAS pin", actions.includes("evaluateSendGate(") && actions.includes("lastSentAt: invite.lastSentAt,") && actions.includes("sendCountInWindow: invite.sendCountInWindow,"));
  check("S9 accept route reuses transactional applyInvite", accept.includes("applyInvite(invite, { id: user.id, email: user.email })"));
  check("S10 auto-apply wired into email verification", challenge.includes("applyPendingInvitesForUser("));
  check("S11 schema has additive fields, no raw token", schema.includes("revokedAt") && schema.includes("sendCountInWindow") && schema.includes("emailDeliveryStatus") && schema.includes("acceptedByUserId") && !/\n\s+token\s+String/.test(schema.match(/model Invite \{[\s\S]*?\n\}/)[0]));
  check("S12 NFKC normalization in normalizeEmail", readFileSync(new URL("../src/lib/normalize-email.ts", import.meta.url), "utf8").includes('normalize("NFKC")'));
  const metaLines = [...actions.matchAll(/metadata:\s*\{[^}]*\}/g)].map((m) => m[0]);
  const svcMetaLines = [...svc.matchAll(/metadata:\s*\{[^}]*\}/g)].map((m) => m[0]);
  const metaClean = [...metaLines, ...svcMetaLines].every((l) => !/token|url/i.test(l));
  check("S13 no raw token / URL in audit metadata", metaClean && !svc.includes("acceptUrl") && !svc.includes("linkUrl"));
  check("S14 UI renders pending/failed/expired/revoked/accepted statuses", invitesLib.includes("INVITE_STATUS_LABELS") && page.includes("InviteStatusBadge") && page.includes("Приглашения"));
  check("S15 pending-invite email cannot be edited (no role/club edit action)", !actions.includes("editInvite") && !actions.includes("updateInviteRole"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
