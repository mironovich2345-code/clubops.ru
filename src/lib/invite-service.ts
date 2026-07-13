// Central invitation application + direct-grant service (Block A6).
//
// The ONLY place that turns an Invite into an access row. Guarantees strict
// single-use via a compare-and-set inside a transaction: the invite is flipped
// to accepted only if it is still pending/non-revoked/non-expired, and access is
// upserted in the same transaction, so a lost race grants nothing and a DB error
// leaves no partial state. Never stores or logs the raw token or invite URL.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/normalize-email";
import { isInviteExpired } from "@/lib/invites";
import { recordAudit } from "@/lib/access";

type InviteRow = {
  id: string;
  email: string;
  companyId: string;
  clubId: string | null;
  role: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

type ApplyUser = { id: string; email: string };

export type ApplyReason =
  | "already"
  | "revoked"
  | "expired"
  | "email_mismatch"
  | "user_invalid";

export type ApplyResult =
  | { ok: true; scope: "company" | "club"; companyId: string; clubId: string | null; role: string }
  | { ok: false; reason: ApplyReason };

/**
 * Apply a single, already-resolved invite to a user. Strict single-use:
 * concurrent double-accept grants access at most once. Audit is written after
 * the transaction commits (best-effort) so an audit failure never rolls back a
 * granted access.
 */
export async function applyInvite(invite: InviteRow, user: ApplyUser): Promise<ApplyResult> {
  // Fast, friendly pre-checks. The real gate is the compare-and-set below.
  if (invite.acceptedAt) return { ok: false, reason: "already" };
  if (invite.revokedAt) return { ok: false, reason: "revoked" };
  if (isInviteExpired(invite.expiresAt)) return { ok: false, reason: "expired" };
  if (normalizeEmail(invite.email) !== normalizeEmail(user.email)) {
    return { ok: false, reason: "email_mismatch" };
  }

  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: { isActive: true, deletedAt: true },
  });
  if (!u || !u.isActive || u.deletedAt) return { ok: false, reason: "user_invalid" };

  const now = new Date();
  let committed = false;
  try {
    committed = await prisma.$transaction(async (tx) => {
      // Compare-and-set: only the first winner flips the invite.
      const cas = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedByUserId: user.id },
      });
      if (cas.count !== 1) return false; // lost the race / became invalid

      if (invite.clubId) {
        await tx.clubUserAccess.upsert({
          where: { clubId_userId_role: { clubId: invite.clubId, userId: user.id, role: invite.role } },
          create: { clubId: invite.clubId, userId: user.id, role: invite.role },
          update: {},
        });
      } else {
        await tx.companyUserAccess.upsert({
          where: { companyId_userId_role: { companyId: invite.companyId, userId: user.id, role: invite.role } },
          create: { companyId: invite.companyId, userId: user.id, role: invite.role },
          update: {},
        });
      }
      // Accepting confirms ownership of the invited email (idempotent).
      await tx.user.updateMany({
        where: { id: user.id, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      return true;
    });
  } catch (error) {
    // A concurrent grant of the SAME (scope,user,role) can still surface P2002 on
    // the upsert create path; the access already exists, so treat as taken.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, reason: "already" };
    }
    throw error;
  }

  if (!committed) return { ok: false, reason: "already" };

  await recordAudit({
    action: "invitation.accepted",
    entityType: "Invite",
    entityId: invite.id,
    companyId: invite.companyId,
    clubId: invite.clubId,
    userId: user.id,
    metadata: { role: invite.role },
  });
  await recordAudit({
    action: "access.granted",
    entityType: invite.clubId ? "ClubUserAccess" : "CompanyUserAccess",
    companyId: invite.companyId,
    clubId: invite.clubId,
    userId: user.id,
    metadata: { role: invite.role, via: "invite", inviteId: invite.id },
  });
  if (invite.role === "chief_accountant") {
    await recordAudit({
      action: "role.chief_accountant_assigned",
      entityType: "CompanyUserAccess",
      companyId: invite.companyId,
      userId: user.id,
      metadata: { via: "invite", inviteId: invite.id },
    });
  }

  return {
    ok: true,
    scope: invite.clubId ? "club" : "company",
    companyId: invite.companyId,
    clubId: invite.clubId,
    role: invite.role,
  };
}

const INVITE_SELECT = {
  id: true,
  email: true,
  companyId: true,
  clubId: true,
  role: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
} as const;

/**
 * Apply EVERY active pending invite for the user's (normalized) email. Called
 * after email verification. Invites are applied sequentially so cross-invite
 * upserts never race. Expired/revoked/accepted invites are skipped by the query
 * and by applyInvite's own guards. Returns per-invite results for onboarding.
 */
export async function applyPendingInvitesForUser(
  user: ApplyUser,
): Promise<{ applied: number; results: ApplyResult[] }> {
  const now = new Date();
  const invites = await prisma.invite.findMany({
    where: {
      email: normalizeEmail(user.email),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "asc" },
    select: INVITE_SELECT,
  });

  const results: ApplyResult[] = [];
  for (const inv of invites) {
    results.push(await applyInvite(inv, user));
  }
  return { applied: results.filter((r) => r.ok).length, results };
}

/**
 * Idempotent DIRECT grant to an existing verified user (no invite row). The
 * caller has already authorized the (role, scope) via getInvitableRoles /
 * canManageClubUsers. Access is upserted; a duplicate grant is a no-op.
 */
export async function grantDirectAccess(params: {
  targetUserId: string;
  actorUserId: string;
  companyId: string;
  clubId: string | null;
  role: string;
}): Promise<void> {
  const { targetUserId, actorUserId, companyId, clubId, role } = params;
  if (clubId) {
    await prisma.clubUserAccess.upsert({
      where: { clubId_userId_role: { clubId, userId: targetUserId, role } },
      create: { clubId, userId: targetUserId, role },
      update: {},
    });
  } else {
    await prisma.companyUserAccess.upsert({
      where: { companyId_userId_role: { companyId, userId: targetUserId, role } },
      create: { companyId, userId: targetUserId, role },
      update: {},
    });
  }
  await recordAudit({
    action: "access.granted",
    entityType: clubId ? "ClubUserAccess" : "CompanyUserAccess",
    companyId,
    clubId,
    userId: actorUserId,
    metadata: { via: "direct_email_grant", role, targetUserId },
  });
  if (role === "chief_accountant") {
    await recordAudit({
      action: "role.chief_accountant_assigned",
      entityType: "CompanyUserAccess",
      companyId,
      userId: actorUserId,
      metadata: { via: "direct_email_grant", targetUserId },
    });
  }
}
