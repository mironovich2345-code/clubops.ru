import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

// Stable ids so migrations and the seed agree, and so concurrent first-load
// requests converge on the same rows instead of creating duplicates.
export const DEMO_COMPANY_ID = "demo-company";
const DEMO_CLUB_ID = "demo-club";
const DEMO_LEGAL_ENTITY_ID = "demo-legal-entity";

/**
 * Ensures minimal demo data exists so the UI is usable while auth is mocked:
 * - the mocked current user row (FK target for invoices/expenses/sales)
 * - the demo company, with the user as its owner
 * - one club attached to the demo company
 * - a demo legal entity (ООО) linked to the club
 *
 * Fully idempotent and concurrency-safe: every write is an upsert (or
 * find-or-create on a stable id), and the rare insert/insert race that two
 * simultaneous first requests can trigger is swallowed (P2002) since the row
 * it complains about is exactly the one we wanted.
 */
export async function ensureDemoData(): Promise<void> {
  // Never touch the database during the production build / static prerender —
  // on Railway the schema isn't migrated until the pre-deploy step.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  try {
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

    await prisma.company.upsert({
      where: { id: DEMO_COMPANY_ID },
      create: { id: DEMO_COMPANY_ID, name: "Демо компания" },
      update: {},
    });

    // Mocked user owns the demo company.
    await prisma.companyUserAccess.upsert({
      where: {
        companyId_userId_role: {
          companyId: DEMO_COMPANY_ID,
          userId: current.id,
          role: "owner",
        },
      },
      create: { companyId: DEMO_COMPANY_ID, userId: current.id, role: "owner" },
      update: {},
    });

    // Reuse an existing club (keeps legacy cuid rows) or create one with a
    // stable id so concurrent creates collide on the PK instead of duplicating.
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
    // Two simultaneous first-load requests can both pass an upsert's existence
    // check and then both INSERT; the loser hits a unique/PK violation. The
    // winner already created the row, so the data is correct — converge quietly.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2025")
    ) {
      return;
    }
    throw error;
  }
}
