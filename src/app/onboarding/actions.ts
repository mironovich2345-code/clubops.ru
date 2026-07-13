"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/access";

// Not exported (a "use server" module may only export async functions).
type OnboardingState = { ok: boolean; error?: string };

export async function completeOnboarding(
  _prev: OnboardingState | undefined,
  formData: FormData,
): Promise<OnboardingState> {
  const user = await requireUser();

  // Prevent duplicate onboarding: if the user already has any access, leave.
  const [companyAccess, clubAccess] = await Promise.all([
    prisma.companyUserAccess.findFirst({ where: { userId: user.id }, select: { id: true } }),
    prisma.clubUserAccess.findFirst({ where: { userId: user.id }, select: { id: true } }),
  ]);
  if (companyAccess || clubAccess) redirect("/dashboard");

  // An invited user must accept their invite, not create a new company here.
  const pendingInvite = await prisma.invite.findFirst({
    where: { email: user.email.toLowerCase(), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (pendingInvite) redirect("/accept-invite");

  const companyName = String(formData.get("companyName") ?? "").trim();
  const clubName = String(formData.get("clubName") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();

  if (!companyName) return { ok: false, error: "Укажите название компании" };
  if (!clubName) return { ok: false, error: "Укажите название клуба" };

  // The first user of a new tenant becomes its owner (company + club level).
  const { companyId, clubId } = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name: companyName } });
    const club = await tx.club.create({
      data: { name: clubName, city: city || "—", companyId: company.id },
    });
    await tx.companyUserAccess.create({
      data: { companyId: company.id, userId: user.id, role: "owner" },
    });
    await tx.clubUserAccess.create({
      data: { clubId: club.id, userId: user.id, role: "owner" },
    });
    return { companyId: company.id, clubId: club.id };
  });

  await recordAudit({
    action: "company.created",
    entityType: "Company",
    entityId: companyId,
    companyId,
    userId: user.id,
    metadata: { name: companyName },
  });
  await recordAudit({
    action: "club.created",
    entityType: "Club",
    entityId: clubId,
    companyId,
    clubId,
    userId: user.id,
    metadata: { name: clubName },
  });
  await recordAudit({
    action: "onboarding.completed",
    entityType: "User",
    entityId: user.id,
    companyId,
    clubId,
    userId: user.id,
  });

  redirect("/dashboard");
}
