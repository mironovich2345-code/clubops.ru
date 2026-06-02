import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";

// Stable ids so migrations and the seed agree, and so concurrent writes converge
// on the same rows instead of creating duplicates.
export const DEMO_COMPANY_ID = "demo-company";
const DEMO_CLUB_ID = "demo-club";
const DEMO_LEGAL_ENTITY_ID = "demo-legal-entity";

const DEMO_OWNER_EMAIL = "owner@club.local";
const DEMO_OWNER_PASSWORD = "demo12345"; // local/dev only — never used in production

/** Dev-only demo credentials, surfaced as a hint on the login page. */
export const DEV_DEMO_CREDENTIALS = {
  email: DEMO_OWNER_EMAIL,
  password: DEMO_OWNER_PASSWORD,
};

/**
 * Idempotent demo company + owner access + club + legal entity for `userId`.
 * Used by the first registration and the dev owner bootstrap. Concurrency-safe:
 * the rare insert/insert race is swallowed (P2002/P2025).
 */
export async function setupDemoCompanyForOwner(userId: string): Promise<void> {
  try {
    await prisma.company.upsert({
      where: { id: DEMO_COMPANY_ID },
      create: { id: DEMO_COMPANY_ID, name: "Демо компания" },
      update: {},
    });

    await prisma.companyUserAccess.upsert({
      where: {
        companyId_userId_role: { companyId: DEMO_COMPANY_ID, userId, role: "owner" },
      },
      create: { companyId: DEMO_COMPANY_ID, userId, role: "owner" },
      update: {},
    });

    let club = await prisma.club.findFirst({ where: { companyId: DEMO_COMPANY_ID } });
    if (!club) {
      club = await prisma.club.create({
        data: {
          id: DEMO_CLUB_ID,
          name: "Фитнес-клуб Демо",
          city: "Москва",
          companyId: DEMO_COMPANY_ID,
        },
      });
    }

    let legalEntity = await prisma.legalEntity.findFirst({
      where: { companyId: DEMO_COMPANY_ID },
    });
    if (!legalEntity) {
      legalEntity = await prisma.legalEntity.create({
        data: {
          id: DEMO_LEGAL_ENTITY_ID,
          companyId: DEMO_COMPANY_ID,
          type: "ООО",
          name: "ООО «Демо»",
        },
      });
    }

    await prisma.clubLegalEntity.upsert({
      where: {
        clubId_legalEntityId: { clubId: club.id, legalEntityId: legalEntity.id },
      },
      create: { clubId: club.id, legalEntityId: legalEntity.id },
      update: {},
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2025")
    ) {
      return;
    }
    throw error;
  }
}

/** True when the system has no users yet — the first registrant becomes owner. */
export async function isFirstUser(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

/**
 * Dev/local-only bootstrap: ensures a demo owner account exists so the local
 * beta stays usable without registering. Never runs during the production build
 * or in production, and never logs anyone in automatically.
 */
export async function ensureDevOwner(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const existing = await prisma.user.findUnique({ where: { email: DEMO_OWNER_EMAIL } });
  if (existing?.passwordHash) return; // already usable

  const passwordHash = await hashPassword(DEMO_OWNER_PASSWORD);
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, role: "owner", isActive: true },
      })
    : await prisma.user.create({
        data: {
          email: DEMO_OWNER_EMAIL,
          name: "Владелец",
          role: "owner",
          passwordHash,
          isActive: true,
        },
      });

  await setupDemoCompanyForOwner(user.id);
}
