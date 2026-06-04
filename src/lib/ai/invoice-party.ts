// Counterparty resolution for invoice extraction.
//
// For an expense invoice in CLUB-OPS, `counterpartyName` must be the SUPPLIER /
// payment recipient (Поставщик / Получатель), never the payer (Плательщик) or
// our own company. The model is asked to return supplierName and payerName
// separately so we can prefer the supplier and detect payer/supplier confusion.
//
// Pure module (no imports) so it is unit-testable in isolation.

export function normalizeName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]/g, "");
}

export function namesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na !== "" && na === nb;
}

export type PartyResolution = {
  counterpartyName: string | null;
  payerConflict: boolean;
};

/**
 * Resolves the counterparty (supplier) and flags a payer/supplier conflict.
 * - Prefers an explicit supplier over whatever the model put in counterpartyName.
 * - Flags a conflict when the model's counterpartyName matches the payer (it
 *   likely picked the payer), or when the resolved name still equals the payer.
 */
export function resolveCounterparty(input: {
  counterpartyName: string | null;
  supplierName: string | null;
  payerName: string | null;
}): PartyResolution {
  const rawCp = input.counterpartyName;
  const supplier = input.supplierName;
  const payer = input.payerName;

  // Prefer the explicit supplier as the source of truth.
  let counterparty = supplier ?? rawCp;
  let payerConflict = false;

  // The model put the payer into counterpartyName while a different supplier
  // exists (or no supplier at all).
  if (payer && rawCp && namesEqual(rawCp, payer) && !namesEqual(supplier, payer)) {
    payerConflict = true;
    if (supplier) counterparty = supplier;
  }

  // After resolution the counterparty still equals the payer — couldn't separate.
  if (payer && namesEqual(counterparty, payer)) {
    payerConflict = true;
  }

  return { counterpartyName: counterparty ?? null, payerConflict };
}

export type PayerMatch = "match" | "mismatch" | "unknown";

function normalizeInn(inn: string | null | undefined): string {
  return (inn ?? "").replace(/\D/g, "");
}

/**
 * Compares the invoice payer with the selected company. Prefers INN/KPP when
 * both sides have an INN; otherwise falls back to normalized name comparison.
 * Returns "unknown" when the payer could not be identified.
 */
export function comparePayer(
  payer: { name: string | null; inn: string | null; kpp: string | null },
  company: { name: string; inn: string | null; kpp: string | null },
): PayerMatch {
  const payerInn = normalizeInn(payer.inn);
  const companyInn = normalizeInn(company.inn);
  if (payerInn && companyInn) {
    return payerInn === companyInn ? "match" : "mismatch";
  }
  if (payer.name) {
    return namesEqual(payer.name, company.name) ? "match" : "mismatch";
  }
  return "unknown";
}
