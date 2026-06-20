// Manual security retention cleanup (Part 19). Hard-deletes stale OTP challenges
// AND stale sessions (consumed/revoked/expired older than the retention window).
// No scheduler. Current usable rows are never deleted.
//
//   npm run security:cleanup                 (30-day retention)
//   RETENTION_DAYS=7 npm run security:cleanup
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const days = Number(process.env.RETENTION_DAYS ?? "30");

async function main() {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const challenges = await p.emailOtpChallenge.deleteMany({
    where: {
      OR: [
        { consumedAt: { not: null, lt: cutoff } },
        { revokedAt: { not: null, lt: cutoff } },
        { expiresAt: { lt: cutoff } },
      ],
    },
  });

  const sessions = await p.session.deleteMany({
    where: {
      OR: [
        { revokedAt: { not: null, lt: cutoff } },
        { expiresAt: { lt: cutoff } },
      ],
    },
  });

  console.log(`Deleted ${challenges.count} stale OTP challenge(s) and ${sessions.count} stale session(s) older than ${days} day(s).`);
  await p.$disconnect();
}

main().catch(async (e) => { console.error(e); await p.$disconnect(); process.exit(1); });
