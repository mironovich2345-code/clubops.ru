// ПИН критических настроек компании. ОТДЕЛЬНЫЙ секрет — НИКОГДА не пароль пользователя:
// хэшируется bcrypt (одно­сторонний), сравнивается только с Company.settingsPinHash, а не
// с passwordHash другого пользователя. Успешная проверка создаёт короткоживущую
// server-side verification session (httpOnly cookie + SettingsPinSession, TTL 15 мин),
// после серии неверных попыток — блокировка. Пока ПИН не задан — гейт не действует
// (opt-in), чтобы не ломать существующие потоки.
import "server-only";
import { randomBytes, createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { resolveSecret } from "@/lib/env-secrets";

export const SETTINGS_PIN_COOKIE = "club_ops_settings_pin";
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 минут
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 32;

export type PinResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

/** HMAC(SESSION_SECRET) of the raw session token — только хэш хранится в БД. */
function hashSessionToken(token: string): string {
  const key = resolveSecret("SESSION_SECRET", { minLength: 32, devFallback: "dev-insecure-session-secret-not-for-production-use-only" });
  return createHmac("sha256", key).update(`settings-pin:${token}`).digest("hex");
}

/** Первичный собственник компании (задаёт/меняет ПИН). */
export async function isPrimaryOwner(companyId: string, userId: string): Promise<boolean> {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { primaryOwnerUserId: true } });
  return Boolean(c?.primaryOwnerUserId && c.primaryOwnerUserId === userId);
}

export type PinStatus = { configured: boolean; lockedUntil: Date | null; isPrimaryOwner: boolean; verified: boolean };

export async function getSettingsPinStatus(companyId: string, userId: string): Promise<PinStatus> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { settingsPinHash: true, settingsPinLockedUntil: true, primaryOwnerUserId: true },
  });
  return {
    configured: Boolean(c?.settingsPinHash),
    lockedUntil: c?.settingsPinLockedUntil ?? null,
    isPrimaryOwner: Boolean(c?.primaryOwnerUserId && c.primaryOwnerUserId === userId),
    verified: await hasVerifiedSettingsPin(companyId, userId),
  };
}

function validatePinFormat(pin: string): PinResult {
  if (!/^\d{4,32}$/.test(pin)) return { ok: false, error: "ПИН должен состоять из 4–32 цифр." };
  return { ok: true, value: undefined };
}

/**
 * Set or change the settings PIN. Primary owner only. When one already exists, the
 * current PIN must be supplied (change), NOT any account password.
 */
export async function setSettingsPin(
  companyId: string,
  userId: string,
  input: { currentPin?: string; newPin: string },
): Promise<PinResult> {
  if (!(await isPrimaryOwner(companyId, userId))) {
    return { ok: false, error: "ПИН настроек задаёт только первичный собственник компании." };
  }
  const fmt = validatePinFormat(input.newPin);
  if (!fmt.ok) return fmt;

  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { settingsPinHash: true } });
  if (c?.settingsPinHash) {
    // Changing: verify the CURRENT settings PIN (never a user password).
    if (!input.currentPin || !(await verifyPassword(input.currentPin, c.settingsPinHash))) {
      return { ok: false, error: "Текущий ПИН неверен." };
    }
  }
  const hash = await hashPassword(input.newPin);
  await prisma.company.update({
    where: { id: companyId },
    data: { settingsPinHash: hash, settingsPinSetAt: new Date(), settingsPinSetByUserId: userId, settingsPinFailedAttempts: 0, settingsPinLockedUntil: null },
  });
  return { ok: true, value: undefined };
}

/**
 * Verify a PIN and, on success, mint a short-lived verification session (cookie +
 * SettingsPinSession). On failure, increment the attempt counter and lock after
 * MAX_FAILED. Any owner of the company may verify (primary or invited) — the PIN itself
 * is the shared company secret; there is no access to anyone's password.
 */
export async function verifySettingsPin(companyId: string, userId: string, pin: string): Promise<PinResult> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { settingsPinHash: true, settingsPinLockedUntil: true, settingsPinFailedAttempts: true },
  });
  if (!c?.settingsPinHash) return { ok: false, error: "ПИН настроек не задан." };
  if (c.settingsPinLockedUntil && c.settingsPinLockedUntil.getTime() > Date.now()) {
    return { ok: false, error: "Слишком много попыток. Попробуйте позже." };
  }
  const ok = await verifyPassword(pin, c.settingsPinHash);
  if (!ok) {
    const attempts = (c.settingsPinFailedAttempts ?? 0) + 1;
    const locked = attempts >= MAX_FAILED;
    await prisma.company.update({
      where: { id: companyId },
      data: { settingsPinFailedAttempts: locked ? 0 : attempts, settingsPinLockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null },
    });
    return { ok: false, error: locked ? "Слишком много попыток. Доступ временно заблокирован." : "Неверный ПИН." };
  }

  // Success: reset attempts, mint the verification session.
  await prisma.company.update({ where: { id: companyId }, data: { settingsPinFailedAttempts: 0, settingsPinLockedUntil: null } });
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.settingsPinSession.create({ data: { userId, companyId, tokenHash: hashSessionToken(token), expiresAt } });
  const store = await cookies();
  store.set(SETTINGS_PIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return { ok: true, value: undefined };
}

/** True if the caller holds a valid verification session for this company. */
export async function hasVerifiedSettingsPin(companyId: string, userId: string): Promise<boolean> {
  const store = await cookies();
  const token = store.get(SETTINGS_PIN_COOKIE)?.value;
  if (!token) return false;
  const session = await prisma.settingsPinSession.findUnique({ where: { tokenHash: hashSessionToken(token) } });
  if (!session || session.revokedAt) return false;
  if (session.userId !== userId || session.companyId !== companyId) return false;
  return session.expiresAt.getTime() > Date.now();
}

/** Clear the verification session (revoke + drop cookie). */
export async function clearSettingsPinSession(companyId: string, userId: string): Promise<void> {
  const store = await cookies();
  const token = store.get(SETTINGS_PIN_COOKIE)?.value;
  if (token) {
    await prisma.settingsPinSession.updateMany({ where: { tokenHash: hashSessionToken(token), userId, companyId }, data: { revokedAt: new Date() } });
    store.delete(SETTINGS_PIN_COOKIE);
  }
}

/**
 * Guard for critical settings actions. OPT-IN: if no PIN is configured for the company,
 * it passes (existing flows unchanged). Once a PIN exists, a valid verification session
 * is required; otherwise returns a PIN_REQUIRED error the UI handles by prompting.
 */
export async function requireSettingsPin(companyId: string, userId: string): Promise<PinResult> {
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { settingsPinHash: true } });
  if (!c?.settingsPinHash) return { ok: true, value: undefined }; // not configured — no gate
  if (await hasVerifiedSettingsPin(companyId, userId)) return { ok: true, value: undefined };
  return { ok: false, error: "PIN_REQUIRED" };
}
