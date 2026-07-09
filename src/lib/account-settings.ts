// Pure validation + normalization for self-service account settings (profile
// name, password change, email change). No server imports here — reused by the
// server actions AND mirrored by the pilot. Never logs or stores secrets.
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { normalizeEmail } from "@/lib/normalize-email";

export const NAME_MIN = 1;
export const NAME_MAX = 80;

// Unicode: Cyrillic, hyphen, apostrophe, spaces).

// True if the string contains any C0/C1 control character (0x00-0x1F, 0x7F-0x9F).
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Collapse internal whitespace + trim; keeps Unicode (Cyrillic, hyphen,
 * apostrophe, space) intact. Comparison/display form. */
export function normalizeName(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

export type NameCheck = { ok: true; value: string } | { ok: false; error: string };

/** Validate one name field (first or last). Unicode allowed; 1–80 chars; no
 * control characters. Not over-restrictive (letters of any script permitted). */
export function validateNameField(raw: string, label: "Имя" | "Фамилия"): NameCheck {
  const value = normalizeName(String(raw ?? ""));
  if (value.length < NAME_MIN) return { ok: false, error: `${label} обязательно` };
  if (value.length > NAME_MAX) return { ok: false, error: `${label}: не более ${NAME_MAX} символов` };
  if (hasControlChars(value)) return { ok: false, error: `${label} содержит недопустимые символы` };
  return { ok: true, value };
}

/** Single source of truth: the display `name` is derived from first + last. */
export function composeDisplayName(firstName: string, lastName: string): string {
  return normalizeName(`${firstName} ${lastName}`) || firstName || lastName || "Пользователь";
}

export type PasswordCheck = { ok: true } | { ok: false; error: string };

/** New-password policy (mirrors registration: min length). Extendable centrally. */
export function validateNewPassword(newPassword: string, confirm: string, currentPassword: string): PasswordCheck {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` };
  }
  if (newPassword !== confirm) {
    return { ok: false, error: "Пароли не совпадают" };
  }
  if (newPassword === currentPassword) {
    return { ok: false, error: "Новый пароль должен отличаться от текущего" };
  }
  return { ok: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailCheck = { ok: true; value: string } | { ok: false; error: string };

/** Validate + normalize a target email for a change (format + not-tombstone).
 * Uniqueness / same-as-current are checked server-side against the DB. */
export function validateNewEmail(raw: string, currentEmail: string): EmailCheck {
  const value = normalizeEmail(String(raw ?? ""));
  if (!EMAIL_RE.test(value)) return { ok: false, error: "Введите корректный email" };
  if (isTombstoneEmail(value)) return { ok: false, error: "Этот email недопустим" };
  if (value === normalizeEmail(currentEmail)) return { ok: false, error: "Новый email совпадает с текущим" };
  return { ok: true, value };
}

/** Tombstone emails belong to deleted accounts and can never be targeted. */
export function isTombstoneEmail(email: string): boolean {
  return /@account\.invalid$/i.test(email.trim());
}
