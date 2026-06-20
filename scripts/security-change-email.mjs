// Administrative email change (Part 15). Server-side ONLY — there is no tenant
// web UI for this. The new email is verified by OTP on the next login.
//
//   npm run security:change-email -- --user=<current-email-or-id> --email=<new-email>
//
// Behavior: validate + normalize new email, ensure unused, update User.email,
// clear emailVerifiedAt, revoke all sessions + active OTP challenges, write a
// system audit event. Never prints secrets or password hashes.
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const rawEmail = arg("email");
  if (!ref || !rawEmail) {
    console.error("Usage: npm run security:change-email -- --user=<email-or-id> --email=<new-email>");
    process.exit(2);
  }
  const newEmail = rawEmail.toLowerCase().trim();
  if (!EMAIL_RE.test(newEmail)) { console.error("Invalid email format."); process.exit(2); }

  const user = await findUser(ref);
  if (!user) { console.error("User not found."); process.exit(1); }

  const clash = await p.user.findUnique({ where: { email: newEmail } });
  if (clash && clash.id !== user.id) { console.error("Email already in use."); process.exit(1); }

  const now = new Date();
  const result = await p.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { email: newEmail, emailVerifiedAt: null } });
    const sessions = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "email_changed_by_system" } });
    const challenges = await tx.emailOtpChallenge.updateMany({ where: { userId: user.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now, revokedReason: "email_changed_by_system" } });
    await tx.auditLog.create({
      data: {
        action: "user.email_changed_by_system",
        entityType: "User",
        entityId: user.id,
        userId: null, // system actor
        metadataJson: JSON.stringify({ actor: "system_cli", targetUserId: user.id, revokedSessions: sessions.count, revokedChallenges: challenges.count }),
      },
    });
    return { sessions: sessions.count, challenges: challenges.count };
  });

  console.log(`Email updated. Revoked ${result.sessions} session(s) and ${result.challenges} challenge(s). New email verified on next OTP login.`);
  await p.$disconnect();
}

main().catch(async (e) => { console.error(e.message ?? e); await p.$disconnect(); process.exit(1); });
