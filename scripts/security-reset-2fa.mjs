// Administrative 2FA reset (Part 16). Server-side ONLY. OTP is NEVER disabled —
// reset forces password + a fresh email OTP on next login.
//
//   npm run security:reset-2fa -- --user=<email-or-id>
//
// Behavior: revoke all active OTP challenges, clear emailVerifiedAt, revoke all
// active sessions, write a system audit event. Historical rows are preserved.
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

function arg(name) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function findUser(ref) {
  if (!ref) return null;
  const byId = await p.user.findUnique({ where: { id: ref } });
  if (byId) return byId;
  return p.user.findUnique({ where: { email: ref.toLowerCase().trim() } });
}

async function main() {
  const ref = arg("user");
  if (!ref) { console.error("Usage: npm run security:reset-2fa -- --user=<email-or-id>"); process.exit(2); }

  const user = await findUser(ref);
  if (!user) { console.error("User not found."); process.exit(1); }

  const now = new Date();
  const result = await p.$transaction(async (tx) => {
    const challenges = await tx.emailOtpChallenge.updateMany({ where: { userId: user.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now, revokedReason: "two_factor_reset_by_system" } });
    await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
    const sessions = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "two_factor_reset_by_system" } });
    await tx.auditLog.create({
      data: {
        action: "user.two_factor_reset_by_system",
        entityType: "User",
        entityId: user.id,
        userId: null,
        metadataJson: JSON.stringify({ actor: "system_cli", targetUserId: user.id, revokedSessions: sessions.count, revokedChallenges: challenges.count }),
      },
    });
    return { sessions: sessions.count, challenges: challenges.count };
  });

  console.log(`2FA reset. Revoked ${result.sessions} session(s) and ${result.challenges} challenge(s). Password + new email OTP required on next login.`);
  await p.$disconnect();
}

main().catch(async (e) => { console.error(e.message ?? e); await p.$disconnect(); process.exit(1); });
