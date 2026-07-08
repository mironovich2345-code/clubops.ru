// Membership refund calculation (Refund v2, returnType=membership) — Phase 2A.
// Pure + server-safe (no imports) so it is the single source of truth AND is
// mirrored by tests. Date-only semantics via UTC day-index (no DST/timezone
// drift). Money is integer kopeks; the final refund is rounded UP to a whole
// ruble using BigInt (the per-day price is NEVER rounded on its own).

export const REFUND_CALC_VERSION = "membership_v1";

export type DateOnly = { y: number; m: number; d: number };

/** Parse "YYYY-MM-DD" (date-only). Returns null on malformed / impossible dates. */
export function parseDateOnly(s: string | null | undefined): DateOnly | null {
  const m = String(s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Round-trip check rejects impossible days (e.g. 2026-02-30).
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** A Date at LOCAL midnight for storage (date-only). */
export function toLocalMidnight(v: DateOnly): Date {
  return new Date(v.y, v.m - 1, v.d);
}
/** Extract a DateOnly from a stored Date using its LOCAL components. */
export function fromDate(dt: Date): DateOnly {
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

const dayIndex = (v: DateOnly): number => Math.floor(Date.UTC(v.y, v.m - 1, v.d) / 86400000);
/** Calendar-day difference a − b (no +1, no DST drift). */
export function diffDays(a: DateOnly, b: DateOnly): number {
  return dayIndex(a) - dayIndex(b);
}
/** 0=Sun … 6=Sat for a date-only value. */
export function weekday(v: DateOnly): number {
  return new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();
}
export function addDays(v: DateOnly, n: number): DateOnly {
  const dt = new Date(Date.UTC(v.y, v.m - 1, v.d) + n * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
export function formatDateOnly(v: DateOnly): string {
  return `${String(v.d).padStart(2, "0")}.${String(v.m).padStart(2, "0")}.${v.y}`;
}

/** Rubles → integer kopeks. Rejects negatives/garbage; allows ≤2 decimals. */
export function parseContractAmountKopeks(raw: string): number | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [rub, frac = ""] = s.split(".");
  const kopeks = BigInt(rub) * 100n + BigInt((frac + "00").slice(0, 2));
  return Number(kopeks);
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b; // a,b > 0
/** Round a kopeks value UP to a whole ruble; result is a multiple of 100. */
export function ceilToRubleKopeks(kopeks: number): number {
  const rubles = ceilDiv(BigInt(Math.trunc(kopeks)), 100n);
  return Number(rubles * 100n);
}

export type MembershipInput = {
  start: DateOnly; end: DateOnly; application: DateOnly;
  contractAmountKopeks: number; serviceNotProvided: boolean;
};

export type PlannedDate = { base: DateOnly; planned: DateOnly; adjustmentReason: string | null };

export const SAT_ADJUST_REASON = "Плановая дата приходилась на субботу, поэтому возврат перенесён на предыдущий рабочий день — пятницу.";
export const SUN_ADJUST_REASON = "Плановая дата приходилась на воскресенье, поэтому возврат перенесён на следующий рабочий день — понедельник.";

/** base = application + 10 calendar days; Sat → previous Friday, Sun → next Monday. */
export function computePlannedRefundDate(application: DateOnly): PlannedDate {
  const base = addDays(application, 10);
  const wd = weekday(base);
  if (wd === 6) return { base, planned: addDays(base, -1), adjustmentReason: SAT_ADJUST_REASON };
  if (wd === 0) return { base, planned: addDays(base, 1), adjustmentReason: SUN_ADJUST_REASON };
  return { base, planned: base, adjustmentReason: null };
}

export type MembershipResult =
  | { ok: false; error: string }
  | {
      ok: true;
      mode: "formula" | "before_start" | "not_provided";
      durationDays: number;
      refundableDays: number | null;
      dayPriceKopeksApprox: number; // informational only — never used in the math
      resultAmountKopeks: number;
      zeroRemaining: boolean;
      durationWarning: boolean;
      base: DateOnly;
      planned: DateOnly;
      adjustmentReason: string | null;
    };

export function computeMembershipRefund(input: MembershipInput): MembershipResult {
  const { start, end, application, contractAmountKopeks: X, serviceNotProvided } = input;
  if (!Number.isInteger(X) || X <= 0) return { ok: false, error: "Сумма договора должна быть больше нуля." };

  const T = diffDays(end, start);
  if (T <= 0) return { ok: false, error: "Дата окончания услуги должна быть позже даты начала." };
  if (diffDays(end, application) < 0) return { ok: false, error: "Дата заявления указана позже окончания срока услуги. Возврат по этому договору оформить нельзя." };

  const { base, planned, adjustmentReason } = computePlannedRefundDate(application);
  const durationWarning = !(T === 30 || T === 31);
  const dayPriceKopeksApprox = Math.round(X / T);

  // Full-refund modes: service not provided, OR application before the start.
  if (serviceNotProvided || diffDays(start, application) > 0) {
    return {
      ok: true, mode: serviceNotProvided ? "not_provided" : "before_start",
      durationDays: T, refundableDays: null, dayPriceKopeksApprox,
      resultAmountKopeks: ceilToRubleKopeks(X), zeroRemaining: false,
      durationWarning, base, planned, adjustmentReason,
    };
  }

  // Formula: Z <= O <= Y. R = X × P / T, rounded UP to a whole ruble.
  const P = diffDays(end, application);
  const numerator = BigInt(X) * BigInt(P);
  const rubles = numerator === 0n ? 0n : ceilDiv(numerator, BigInt(T) * 100n);
  const resultAmountKopeks = Number(rubles * 100n);
  return {
    ok: true, mode: "formula", durationDays: T, refundableDays: P, dayPriceKopeksApprox,
    resultAmountKopeks, zeroRemaining: P === 0, durationWarning, base, planned, adjustmentReason,
  };
}

export const DURATION_WARNING = "Период услуги отличается от обычных 30–31 дней. Проверьте даты договора.";
