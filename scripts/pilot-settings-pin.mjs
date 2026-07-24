// ПИН критических настроек компании. Проверяет: bcrypt-хэш (не plaintext, не пароль
// пользователя), формат/блокировку, деривацию первичного собственника, и статические
// гарантии безопасности (cookie httpOnly/secure, session-tokenHash, opt-in guard,
// rate-limit, аудит, аддитивная миграция).
// npm run pilot:settings-pin
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- mirror: PIN format (settings-pin.ts) ----
const validPin = (pin) => /^\d{4,32}$/.test(pin);
// ---- mirror: lock after MAX_FAILED ----
const MAX_FAILED = 5;
function onFail(attempts) {
  const next = attempts + 1;
  const locked = next >= MAX_FAILED;
  return { failedAttempts: locked ? 0 : next, locked };
}
// ---- mirror: earliest-owner primary designation (backfill) ----
function primaryOwner(accessRows) {
  const owners = accessRows.filter((r) => r.role === "owner").sort((a, b) => a.createdAt - b.createdAt);
  return owners.length ? owners[0].userId : null;
}

async function main() {
  // --- bcrypt round-trip (PIN is hashed one-way, never plaintext) ---
  const hash = await bcrypt.hash("4821", 10);
  check("PIN1 PIN is bcrypt-hashed (not plaintext)", hash !== "4821" && hash.startsWith("$2"));
  check("PIN2 correct PIN verifies, wrong PIN rejected", (await bcrypt.compare("4821", hash)) === true && (await bcrypt.compare("0000", hash)) === false);

  // --- format ---
  check("PIN3 format is 4–32 digits", validPin("4821") && validPin("12345678") && !validPin("12") && !validPin("abcd") && !validPin(""));

  // --- lock ---
  let a = 0, lockedAt = null;
  for (let i = 1; i <= MAX_FAILED; i++) { const r = onFail(a); a = r.failedAttempts; if (r.locked) lockedAt = i; }
  check("PIN4 locks after 5 failed attempts", lockedAt === MAX_FAILED);

  // --- primary owner = earliest owner (not oldest user) ---
  const rows = [
    { userId: "invited", role: "owner", createdAt: 200 },
    { userId: "founder", role: "owner", createdAt: 100 },
    { userId: "gd", role: "general_director", createdAt: 50 },
  ];
  check("PIN5 primary owner is the earliest OWNER access row", primaryOwner(rows) === "founder");

  // ---- static guards ----
  const lib = src("../src/lib/settings-pin.ts");
  const actions = src("../src/app/(app)/settings/pin-actions.ts");
  const rate = src("../src/lib/rate-limit.ts");
  const ofdActions = src("../src/app/(app)/settings/integrations/ofd/actions.ts");
  const schema = src("../prisma/schema.prisma");
  const prodMig = src("../prisma/production/migrations/20260724120537_add_settings_pin/migration.sql");
  const createCompany = src("../src/app/(app)/settings/actions.ts");
  const onboarding = src("../src/app/onboarding/actions.ts");

  check("PINS1 PIN hashed via bcrypt helpers, compared ONLY to Company.settingsPinHash",
    lib.includes("hashPassword") && lib.includes("verifyPassword") && lib.includes("verifyPassword(pin, c.settingsPinHash)"));
  check("PINS2 never uses another user's account password",
    !lib.includes("verifyLoginPassword") && !lib.includes(".passwordHash"));
  check("PINS3 verification session cookie is httpOnly + secure in prod + path-scoped",
    lib.includes("httpOnly: true") && lib.includes('secure: process.env.NODE_ENV === "production"') && lib.includes("SETTINGS_PIN_COOKIE"));
  check("PINS4 only the session token HASH is stored (raw token in cookie only)",
    lib.includes("hashSessionToken(token)") && lib.includes("tokenHash: hashSessionToken"));
  check("PINS5 guard is OPT-IN (no PIN configured → passes; existing flows unchanged)",
    lib.includes("if (!c?.settingsPinHash) return { ok: true") && lib.includes('return { ok: false, error: "PIN_REQUIRED" }'));
  check("PINS6 set/change requires primary owner + current PIN on change (not a password)",
    lib.includes("isPrimaryOwner(companyId, userId)") && lib.includes("input.currentPin") && lib.includes("verifyPassword(input.currentPin, c.settingsPinHash)"));
  check("PINS7 attempts throttled by rate limit + failure lock",
    actions.includes('checkRateLimit("settings_pin"') && /"settings_pin:user"/.test(rate) && lib.includes("settingsPinLockedUntil"));
  check("PINS8 a critical action (OFD connection) is gated by requireSettingsPin",
    ofdActions.includes("requireSettingsPin(g.companyId, g.userId)"));
  check("PINS9 actions audited (set/verify/failed)",
    actions.includes('"settings.pin_set"') && actions.includes('"settings.pin_verified"') && actions.includes('"settings.pin_failed"'));
  check("PINS10 primary owner set at company creation (both paths)",
    createCompany.includes("primaryOwnerUserId: admin.id") && onboarding.includes("primaryOwnerUserId: user.id"));
  check("PINS11 additive migration: Company ALTER ADD COLUMN + SettingsPinSession CREATE, no DROP; backfill earliest owner",
    /ALTER TABLE "Company" ADD COLUMN "settingsPinHash"/.test(prodMig) && /CREATE TABLE "SettingsPinSession"/.test(prodMig) &&
    !/DROP TABLE|DROP COLUMN/.test(prodMig) && prodMig.includes("ORDER BY \"createdAt\" ASC LIMIT 1"));
  check("PINS12 model fields present in schema (nullable, additive)",
    schema.includes("primaryOwnerUserId        String?") && schema.includes("settingsPinHash           String?") && schema.includes("model SettingsPinSession"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
