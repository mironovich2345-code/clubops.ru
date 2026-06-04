// Smoke test for supplier-vs-payer counterparty resolution.
// No test runner is wired up — call runInvoicePartySmokeTest() to assert the
// supplier/payer rules (throws on failure).

import { resolveCounterparty, namesEqual, comparePayer } from "./invoice-party";

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

  // comparePayer: INN wins when both sides have one.
  assert(
    "payer match by INN",
    comparePayer(
      { name: "ООО Ромашка", inn: "7701234567", kpp: null },
      { name: "Иное имя", inn: "77 01 234 567", kpp: null },
    ) === "match",
  );
  assert(
    "payer mismatch by INN",
    comparePayer(
      { name: "ООО Ромашка", inn: "7701234567", kpp: null },
      { name: "ООО Ромашка", inn: "9900000000", kpp: null },
    ) === "mismatch",
  );
  // Falls back to normalized name when INN is unavailable on either side.
  assert(
    "payer match by name fallback",
    comparePayer(
      { name: "ООО «Ромашка»", inn: null, kpp: null },
      { name: "ооо ромашка", inn: null, kpp: null },
    ) === "match",
  );
  assert(
    "payer mismatch by name fallback",
    comparePayer(
      { name: "ООО «Ромашка»", inn: null, kpp: null },
      { name: "ООО «Лютик»", inn: null, kpp: null },
    ) === "mismatch",
  );
  // Unknown when the payer could not be identified at all.
  assert(
    "payer unknown without name or inn",
    comparePayer({ name: null, inn: null, kpp: null }, { name: "ООО Ромашка", inn: null, kpp: null }) ===
      "unknown",
  );
}
