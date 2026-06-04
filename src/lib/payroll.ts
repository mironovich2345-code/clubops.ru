import { createHash } from "node:crypto";

// Payroll row deduplication. A signed row is identified by a stable rowHash over
// the normalized employee name, role, amount and period. The same person+amount
// on a re-uploaded statement maps to the same hash, so an already-counted row is
// never counted twice; only newly signed rows add to the expense.

export const PAYROLL_EXPENSE_NOTE =
  "Зарплатная ведомость: учтены только новые подписанные строки";
export const PAYROLL_MESSAGE_NO_NEW_ROWS = "Новых подписанных строк не найдено";

/** Lowercases, unifies ё→е, strips everything but letters/digits. */
export function normalizePayrollField(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]/gi, "");
}

/**
 * Stable hash for a payroll row. Based on normalized employeeName + role +
 * amount (kopeks) + period. Deterministic — identical input always yields the
 * same hash, which is the dedup key (unique per company+club).
 */
export function payrollRowHash(input: {
  employeeName: string | null;
  role: string | null;
  amountKopeks: number;
  period: string | null;
}): string {
  const basis = [
    normalizePayrollField(input.employeeName),
    normalizePayrollField(input.role),
    String(input.amountKopeks),
    normalizePayrollField(input.period),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex");
}
