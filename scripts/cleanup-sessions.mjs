// Manual session retention cleanup (Part 16). Hard-deletes sessions that have
// been EXPIRED or REVOKED for longer than the retention window (default 30 days).
// Mirrors lib/session.cleanupStaleSessions. No scheduler is introduced.
//
// Run: npm run sessions:cleanup            (30-day retention)
//      RETENTION_DAYS=7 npm run sessions:cleanup
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const days = Number(process.env.RETENTION_DAYS ?? "30");

async function main() {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await p.session.deleteMany({
    where: {
      OR: [
        { revokedAt: { not: null, lt: cutoff } },
        { expiresAt: { lt: cutoff } },
      ],
    },
  });
  console.log(`Deleted ${res.count} stale session(s) older than ${days} day(s).`);
  await p.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
