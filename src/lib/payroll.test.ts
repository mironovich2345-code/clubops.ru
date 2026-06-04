// Smoke test for payroll row deduplication hashing.
// Call runPayrollSmokeTest() to assert the rowHash rules (throws on failure).

import { payrollRowHash, normalizePayrollField } from "./payroll";

function assert(label: string, cond: boolean): void {
  if (!cond) throw new Error(`payroll smoke test failed: ${label}`);
}

export function runPayrollSmokeTest(): void {
  const base = { employeeName: "Иванов Иван", role: "Тренер", amountKopeks: 5000000, period: "2026-06" };

  // Same row (after normalization of case/whitespace) -> identical hash (dedup).
  assert(
    "same row -> same hash",
    payrollRowHash(base) === payrollRowHash({ ...base, employeeName: "  иванов   иван ", role: "тренер" }),
  );

  // ё/е unified.
  assert("ё normalizes to е", normalizePayrollField("Алёна") === normalizePayrollField("Алена"));

  // Different amount, role or period -> different hash (counts separately).
  assert("amount changes hash", payrollRowHash(base) !== payrollRowHash({ ...base, amountKopeks: 6000000 }));
  assert("role changes hash", payrollRowHash(base) !== payrollRowHash({ ...base, role: "Администратор" }));
  assert("period changes hash", payrollRowHash(base) !== payrollRowHash({ ...base, period: "2026-07" }));
  assert("null period differs from set", payrollRowHash(base) !== payrollRowHash({ ...base, period: null }));

  // Hash is a stable 64-char hex digest.
  assert("hash is 64 hex", /^[a-f0-9]{64}$/.test(payrollRowHash(base)));
}
