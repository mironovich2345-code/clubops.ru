// Smoke test for supplier-vs-payer counterparty resolution.
// No test runner is wired up — call runInvoicePartySmokeTest() to assert the
// supplier/payer rules (throws on failure).

import { resolveCounterparty, namesEqual } from "./invoice-party";

function assert(label: string, cond: boolean): void {
  if (!cond) throw new Error(`invoice-party smoke test failed: ${label}`);
}

export function runInvoicePartySmokeTest(): void {
  // Required example: model returns the supplier correctly.
  const correct = resolveCounterparty({
    counterpartyName: "ООО «ВК»",
    supplierName: "ООО «ВК»",
    payerName: "ООО «ТРАНДСПОРТ»",
  });
  assert("supplier ВК is counterparty", correct.counterpartyName === "ООО «ВК»");
  assert("no payer conflict for correct case", correct.payerConflict === false);

  // Bug case: model put the payer into counterpartyName; supplier still visible.
  const recovered = resolveCounterparty({
    counterpartyName: "ООО «ТРАНДСПОРТ»",
    supplierName: "ООО «ВК»",
    payerName: "ООО «ТРАНДСПОРТ»",
  });
  assert("prefers supplier over payer", recovered.counterpartyName === "ООО «ВК»");
  assert("flags payer conflict", recovered.payerConflict === true);

  // Bug case with no supplier field: cannot recover, but must flag the conflict.
  const flagged = resolveCounterparty({
    counterpartyName: "ООО «ТРАНДСПОРТ»",
    supplierName: null,
    payerName: "ООО «ТРАНДСПОРТ»",
  });
  assert("flags conflict without supplier", flagged.payerConflict === true);

  // Normalization handles quotes / case.
  assert("namesEqual quotes+case", namesEqual("ООО «ВК»", "ооо вк") === true);
  assert("namesEqual different parties", namesEqual("ООО «ВК»", "ООО «ТРАНДСПОРТ»") === false);
}
