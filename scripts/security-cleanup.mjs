// Manual security retention cleanup. Hard-deletes stale OTP challenges AND stale
// sessions (consumed/revoked/expired older than the retention window), and PURGES
// sensitive recovery data for account deletions whose 30-day window has passed
// (Part 13): the encrypted original email + recovery token hash are cleared and
// recoveryPurgedAt is set, WITHOUT physically deleting the tombstoned User or any
// financial/audit history. Current usable rows are never touched.
//
//   npm run security:cleanup                 (30-day retention)
//   RETENTION_DAYS=7 npm run security:cleanup
//   npm run security:cleanup -- --dry-run     (report counts only, no writes)
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const days = Number(process.env.RETENTION_DAYS ?? "30");
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Recovery records whose window has passed and are not yet purged/restored.
  const purgeableWhere = { restoreUntil: { lt: now }, recoveryPurgedAt: null, restoredAt: null };
  const staleChallengeWhere = {
    OR: [
      { consumedAt: { not: null, lt: cutoff } },
      { revokedAt: { not: null, lt: cutoff } },
      { expiresAt: { lt: cutoff } },
    ],
  };
  const staleSessionWhere = { OR: [{ revokedAt: { not: null, lt: cutoff } }, { expiresAt: { lt: cutoff } }] };

  if (dryRun) {
    const [challenges, sessions, recoveries] = await Promise.all([
      p.emailOtpChallenge.count({ where: staleChallengeWhere }),
      p.session.count({ where: staleSessionWhere }),
      p.accountDeletion.count({ where: purgeableWhere }),
    ]);
    console.log(`[dry-run] would delete ${challenges} OTP challenge(s), ${sessions} session(s); purge ${recoveries} expired recovery record(s). No email addresses or tokens are logged.`);
    return;
  }

  const challenges = await p.emailOtpChallenge.deleteMany({ where: staleChallengeWhere });
  const sessions = await p.session.deleteMany({ where: staleSessionWhere });

  // Fetch purgeable recovery records first so each purge is audited by userId
  // (no email/token is read or logged).
  const purgeable = await p.accountDeletion.findMany({ where: purgeableWhere, select: { id: true, userId: true } });
  const recoveries = await p.accountDeletion.updateMany({
    where: purgeableWhere,
    data: { originalEmailEncrypted: null, restoreTokenHash: null, recoveryPurgedAt: now },
  });
  const purgedUsers = await p.user.updateMany({
    where: { deletedAt: { not: null }, restoreUntil: { lt: now }, recoveryPurgedAt: null },
    data: { recoveryPurgedAt: now },
  });
  for (const d of purgeable) {
    await p.auditLog.create({ data: { action: "account.recovery_expired", entityType: "User", entityId: d.userId, userId: null, metadataJson: JSON.stringify({ via: "cleanup", deletionId: d.id }) } });
  }

  console.log(`Deleted ${challenges.count} stale OTP challenge(s), ${sessions.count} stale session(s); purged ${recoveries.count} recovery record(s) and marked ${purgedUsers.count} tombstone(s). (retention ${days}d)`);
}

main().catch(async (e) => { console.error(e); await p.$disconnect(); process.exit(1); }).finally(() => p.$disconnect());
