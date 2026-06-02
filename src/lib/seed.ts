import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

// Stable id so migrations and the seed agree on the same demo company.
export const DEMO_COMPANY_ID = "demo-company";

/**
 * Ensures minimal demo data exists so the UI is usable while auth is mocked:
 * - the mocked current user row exists (FK target for invoices/expenses/sales)
 * - the demo company exists and the user is its owner
 * - at least one club exists (attached to the demo company)
 * - a demo legal entity (ООО) exists and is linked to the club
 *
 * Safe to call on every request — it's idempotent.
 */
export async function ensureDemoData(): Promise<void> {
  // Never touch the database during the production build / static prerender —
  // on Railway the schema isn't migrated until the pre-deploy step.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const current = await getCurrentUser();

  await prisma.user.upsert({
    where: { id: current.id },
    create: {
      id: current.id,
      email: current.email,
      name: current.name,
      role: current.role,
    },
    update: {
      email: current.email,
      name: current.name,
      role: current.role,
    },
  });

  const company = await prisma.company.upsert({
    where: { id: DEMO_COMPANY_ID },
    create: { id: DEMO_COMPANY_ID, name: "Демо компания" },
    update: {},
  });

  // Mocked user owns the demo company.
  await prisma.companyUserAccess.upsert({
    where: {
      companyId_userId_role: {
        companyId: company.id,
        userId: current.id,
        role: "owner",
      },
    },
    create: { companyId: company.id, userId: current.id, role: "owner" },
    update: {},
  });

  let club = await prisma.club.findFirst({ where: { companyId: company.id } });
  if (!club) {
    club = await prisma.club.create({
      data: { name: "Фитнес-клуб Демо", city: "Москва", companyId: company.id },
    });
  }

  let legalEntity = await prisma.legalEntity.findFirst({ where: { companyId: company.id } });
  if (!legalEntity) {
    legalEntity = await prisma.legalEntity.create({
      data: { companyId: company.id, type: "ООО", name: "ООО «Демо»" },
    });
  }

  await prisma.clubLegalEntity.upsert({
    where: {
      clubId_legalEntityId: { clubId: club.id, legalEntityId: legalEntity.id },
    },
    create: { clubId: club.id, legalEntityId: legalEntity.id },
    update: {},
  });
}
