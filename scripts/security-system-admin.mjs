// Server-only CLI to manage the global system_admin role (Part 2). This role is
// SEPARATE from Company/Club roles and can be granted ONLY here — never through
// tenant UI. Refuses ambiguous users. Never prints password hashes/tokens.
//
//   npm run security:system-admin -- assign user@example.com
//   npm run security:system-admin -- revoke user@example.com
//   npm run security:system-admin -- list
//   (add --prod to run against a PostgreSQL DATABASE_URL)
import { PrismaClient } from "@prisma/client";

const SYSTEM_ADMIN = "system_admin";
const p = new PrismaClient();
const argv = process.argv.slice(2);
const cmd = argv[0];
const selector = argv[1];
const prodFlag = argv.includes("--prod");

const maskEmail = (e) => {
  const [l, d] = String(e).split("@");
  return d ? `${l.slice(0, 1)}***@${d}` : "***";
};

function guardProduction() {
  const url = process.env.DATABASE_URL ?? "";
  const looksProd = /^postgres/i.test(url) || process.env.NODE_ENV === "production";
  if (looksProd && !prodFlag) {
    console.error("Refusing to run against a production database without --prod. Aborting.");
    process.exit(2);
  }
  if (!looksProd && prodFlag) {
    console.error("--prod passed but DATABASE_URL is not PostgreSQL. Aborting.");
    process.exit(2);
  }
}

async function resolveUser(sel) {
  const norm = String(sel).trim().toLowerCase();
  // Accept email or id; refuse if the selector matches more than one distinct user.
  const byEmail = await p.user.findFirst({ where: { email: norm }, select: { id: true, email: true, name: true, systemRole: true, deletedAt: true } });
  const byId = await p.user.findUnique({ where: { id: String(sel).trim() }, select: { id: true, email: true, name: true, systemRole: true, deletedAt: true } });
  const matches = [byEmail, byId].filter(Boolean);
  const distinct = new Map(matches.map((m) => [m.id, m]));
  if (distinct.size === 0) return { error: "Пользователь не найден." };
  if (distinct.size > 1) return { error: "Неоднозначный пользователь (email и id указывают на разных пользователей)." };
  return { user: [...distinct.values()][0] };
}

async function audit(action, userId, actorNote) {
  await p.auditLog.create({ data: { action, entityType: "User", entityId: userId, userId: null, metadataJson: JSON.stringify({ via: "cli", actor: actorNote ?? "system_cli" }) } });
}

async function main() {
  guardProduction();

  if (cmd === "list") {
    const admins = await p.user.findMany({ where: { systemRole: SYSTEM_ADMIN }, select: { id: true, email: true, name: true, isActive: true, deletedAt: true } });
    if (admins.length === 0) { console.log("Системных администраторов нет."); return; }
    console.log(`Системные администраторы (${admins.length}):`);
    for (const a of admins) console.log(`  - ${a.name} <${maskEmail(a.email)}> id=${a.id}${a.deletedAt ? " [удалён]" : a.isActive ? "" : " [неактивен]"}`);
    return;
  }

  if (cmd !== "assign" && cmd !== "revoke") {
    console.error("Использование: assign <email|id> | revoke <email|id> | list");
    process.exit(2);
  }
  if (!selector) { console.error("Укажите email или id пользователя."); process.exit(2); }

  const r = await resolveUser(selector);
  if (r.error) { console.error(r.error); process.exit(1); }
  const user = r.user;

  if (cmd === "assign") {
    if (user.deletedAt) { console.error("Нельзя назначить удалённому аккаунту."); process.exit(1); }
    if (user.systemRole === SYSTEM_ADMIN) { console.log("Пользователь уже системный администратор."); return; }
    await p.user.update({ where: { id: user.id }, data: { systemRole: SYSTEM_ADMIN } });
    await audit("system_admin.assigned", user.id);
    console.log(`Назначен системный администратор: ${user.name} <${maskEmail(user.email)}>.`);
  } else {
    if (user.systemRole !== SYSTEM_ADMIN) { console.log("Пользователь не является системным администратором."); return; }
    await p.user.update({ where: { id: user.id }, data: { systemRole: null } });
    await audit("system_admin.revoked", user.id);
    console.log(`Снят системный администратор: ${user.name} <${maskEmail(user.email)}>.`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }).finally(() => p.$disconnect());
