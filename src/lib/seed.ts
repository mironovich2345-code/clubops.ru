import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

/**
 * Ensures minimal demo data exists so the UI is usable while auth is mocked:
 * - the mocked current user row exists (FK target for invoices)
 * - at least one club exists, so the create form has a selectable option
 *
 * Safe to call on every request — it's idempotent.
 */
export async function ensureDemoData(): Promise<void> {
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

  const clubCount = await prisma.club.count();
  if (clubCount === 0) {
    await prisma.club.create({
      data: { name: "Фитнес-клуб Демо", city: "Москва" },
    });
  }
}
