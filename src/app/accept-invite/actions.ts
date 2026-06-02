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
  const back = `/accept-invite?token=${encodeURIComponent(token)}`;

  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
  });
  if (!invite || invite.acceptedAt || isInviteExpired(invite.expiresAt)) {
    redirect(back);
  }
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

  redirect("/dashboard");
}
