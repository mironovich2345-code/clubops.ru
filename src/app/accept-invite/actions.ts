"use server";

import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/access";
import { hashInviteToken, isInviteExpired } from "@/lib/invites";

export async function acceptInvite(formData: FormData): Promise<void> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "");
  const inviteId = String(formData.get("inviteId") ?? "");
  // Token links return to themselves on failure; the no-token (by-id) flow
  // returns to the email-based list.
  const back = token ? `/accept-invite?token=${encodeURIComponent(token)}` : "/accept-invite";

  // Resolve the invite by token (unauthenticated link) or by id (logged-in user
  // accepting an invite addressed to their email).
  const invite = token
    ? await prisma.invite.findUnique({ where: { tokenHash: hashInviteToken(token) } })
    : inviteId
      ? await prisma.invite.findUnique({ where: { id: inviteId } })
      : null;

  if (!invite || invite.acceptedAt || isInviteExpired(invite.expiresAt)) {
    redirect(back);
  }
  // Email match is the security gate in both flows: a user may only accept an
  // invite addressed to their own email.
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    redirect(back);
  }

  try {
    if (invite.clubId) {
      await prisma.clubUserAccess.upsert({
        where: {
          clubId_userId_role: { clubId: invite.clubId, userId: user.id, role: invite.role },
        },
        create: { clubId: invite.clubId, userId: user.id, role: invite.role },
        update: {},
      });
    } else {
      await prisma.companyUserAccess.upsert({
        where: {
          companyId_userId_role: {
            companyId: invite.companyId,
            userId: user.id,
            role: invite.role,
          },
        },
        create: { companyId: invite.companyId, userId: user.id, role: invite.role },
        update: {},
      });
    }
    await prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    // Accepting an invite confirms ownership of the invited email (the user is
    // already OTP-verified for this email at login). Set emailVerifiedAt if not
    // already set — idempotent, never creates or alters a Session here.
    await prisma.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
  }

  await recordAudit({
    action: "invite.accepted",
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
    metadata: { role: invite.role, viaInvite: invite.id },
  });
  if (invite.role === "chief_accountant") {
    await recordAudit({
      action: "role.chief_accountant_assigned",
      entityType: "CompanyUserAccess",
      companyId: invite.companyId,
      userId: user.id,
      metadata: { viaInvite: invite.id },
    });
  }

  redirect("/dashboard");
}
