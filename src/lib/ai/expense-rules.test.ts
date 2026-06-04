// Smoke test for expense category + confidence rules.
// No test runner is wired up — call runExpenseRulesSmokeTest() to assert the
// category/confidence guards (throws on failure).

import {
  applyExpenseRules,
  hasConsumableItems,
  WARNING_INVESTMENTS_TO_HOUSEHOLD,
  WARNING_MULTIPLE_RECEIPTS,
} from "./expense-rules";

function assert(label: string, cond: boolean): void {
  if (!cond) throw new Error(`expense-rules smoke test failed: ${label}`);
}

export function runExpenseRulesSmokeTest(): void {
  // 1. Crochet/bag consumables must become household, never investments.
  const r1 = applyExpenseRules({
    category: "investments",
    confidence: "high",
    items: ["Крышка TLS", "Майка Пакет"],
    multipleReceipts: false,
  });
  assert("1 household", r1.category === "household");
  assert("1 not investments", r1.category !== "investments");
  assert("1 confidence downgraded from high", r1.confidence !== "high");
  assert("1 correction warning", r1.warnings.includes(WARNING_INVESTMENTS_TO_HOUSEHOLD));

  // 2. Multiple receipts in one image -> never high + warning.
  const r2 = applyExpenseRules({
    category: "household",
    confidence: "high",
    items: ["Пакет"],
    multipleReceipts: true,
  });
  assert("2 confidence not high", r2.confidence !== "high");
  assert("2 multiple-receipts warning", r2.warnings.includes(WARNING_MULTIPLE_RECEIPTS));

  // 3. Real capital purchase -> investments allowed, confidence preserved.
  const r3 = applyExpenseRules({
    category: "investments",
    confidence: "high",
    items: ["Тренажёр силовой", "Беговая дорожка"],
    multipleReceipts: false,
  });
  assert("3 investments kept", r3.category === "investments");
  assert("3 confidence kept high", r3.confidence === "high");
  assert("3 equipment is not consumable", hasConsumableItems(["Тренажёр силовой", "Беговая дорожка"]) === false);

  // 4. Unknown ambiguous receipt -> other + medium/low, untouched.
  const r4 = applyExpenseRules({
    category: "other",
    confidence: "medium",
    items: ["Услуга", "Товар 1"],
    multipleReceipts: false,
  });
  assert("4 stays other", r4.category === "other");
  assert("4 medium or low", r4.confidence === "medium" || r4.confidence === "low");
  assert("4 no spurious warnings", r4.warnings.length === 0);

  // Bonus: the exact reported case — household items + two receipts in one photo.
  const r5 = applyExpenseRules({
    category: "investments",
    confidence: "high",
    items: ["крышка", "пакет", "майка-пакет", "упаковочные хоз. товары"],
    multipleReceipts: true,
  });
  assert("5 household", r5.category === "household");
  assert("5 not high", r5.confidence !== "high");
  assert("5 both warnings", r5.warnings.includes(WARNING_INVESTMENTS_TO_HOUSEHOLD) && r5.warnings.includes(WARNING_MULTIPLE_RECEIPTS));
}
