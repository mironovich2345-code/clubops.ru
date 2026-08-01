// AI extraction QUALITY helpers for invoices (§14–16). Pure, no imports — unit-testable.
// Improves supplier-name extraction/normalization, payer matching by INN (company-scoped),
// and final-payable-amount selection. Every function is conservative: it never invents a
// value; it flags doubt via warnings so the accountant reviews before payment.

// ===================== §14 Supplier (counterparty) name =====================
/**
 * Normalize a supplier name WITHOUT losing meaning: trim, collapse internal whitespace,
 * unify fancy quotes to «». Keeps Cyrillic/Latin/digits/quotes/hyphens/org-forms; never
 * translates or drops significant characters. Returns null for an empty result.
 */
export function normalizeSupplierName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, " ").trim();
  s = s.replace(/[“”„"‟]/g, '"').replace(/[«»]/g, '"'); // unify → ASCII quotes for stability
  // Re-quote to «» if the name is quoted (ОПФ "Name" → ОПФ «Name»), preserving content.
  s = s.replace(/"([^"]+)"/g, "«$1»");
  return s.length ? s : null;
}

export type SupplierWarning =
  | "empty" | "looks_like_address" | "looks_like_bank" | "looks_like_fio"
  | "conflicts_payer_name" | "matches_payer_different_inn" | "low_confidence";

function digits(s: string | null | undefined): string { return (s ?? "").replace(/\D/g, ""); }
function nameKey(s: string | null | undefined): string { return (s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]/g, ""); }

/** Warnings for a supplier name: is it actually an address / bank line / a person's ФИО,
 *  is it empty, or does it collide with the payer (same text but a different INN)? */
export function supplierNameWarnings(input: {
  supplierName: string | null; payerName?: string | null;
  supplierInn?: string | null; payerInn?: string | null; confidence?: string;
}): SupplierWarning[] {
  const w: SupplierWarning[] = [];
  const name = (input.supplierName ?? "").trim();
  if (!name) { w.push("empty"); return w; }
  const low = name.toLowerCase();
  if (/\b(г\.|ул\.|д\.|пр-?кт|проспект|область|обл\.|город|индекс)\b/.test(low) || /\b\d{6}\b/.test(low)) w.push("looks_like_address");
  if (/\b(бик|р\/с|к\/с|расч[её]тный сч[её]т|корр\.?\s*сч[её]т|банк)\b/.test(low) || /\b\d{20}\b/.test(digits(low).length >= 20 ? low : "")) w.push("looks_like_bank");
  // ФИО heuristic: three capitalized Cyrillic words, no organizational form.
  const hasOpf = /\b(ооо|оао|зао|пао|ао|ип|ту|фгуп|муп|нко|учреждение|компания|фирма|завод|"|«)\b/i.test(name);
  if (!hasOpf && /^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$/.test(name.trim())) w.push("looks_like_fio");
  if (input.payerName && nameKey(name) === nameKey(input.payerName)) {
    if (digits(input.supplierInn) && digits(input.payerInn) && digits(input.supplierInn) !== digits(input.payerInn)) w.push("matches_payer_different_inn");
    else w.push("conflicts_payer_name");
  }
  if (input.confidence === "low") w.push("low_confidence");
  return w;
}

// ===================== §15 Payer by INN (company-scoped) =====================
export type InnKind = "legal" | "ip" | "invalid";
export function classifyInn(inn: string | null | undefined): { kind: InnKind; digits: string } {
  const d = digits(inn);
  if (d.length === 10) return { kind: "legal", digits: d };
  if (d.length === 12) return { kind: "ip", digits: d };
  return { kind: "invalid", digits: d };
}

export type PayerMatchResult =
  | { result: "one"; entityId: string; confidence: "high" }
  | { result: "none" }
  | { result: "multiple"; candidateIds: string[] }
  | { result: "invalid_inn" };

/**
 * Match the invoice payer to a LegalEntity of the SELECTED company by INN (primary signal).
 * Never returns an entity of another company (scope is the caller's list). Text name is a
 * secondary signal only (used to disambiguate multiples, handled by the caller).
 */
export function matchPayerByInn(payerInn: string | null | undefined, entities: { id: string; inn: string | null }[]): PayerMatchResult {
  const { kind, digits: d } = classifyInn(payerInn);
  if (kind === "invalid") return { result: "invalid_inn" };
  const hits = entities.filter((e) => digits(e.inn) === d);
  if (hits.length === 1) return { result: "one", entityId: hits[0].id, confidence: "high" };
  if (hits.length === 0) return { result: "none" };
  return { result: "multiple", candidateIds: hits.map((h) => h.id) };
}

// ===================== §16 Final payable amount =====================
export type AmountCandidate = { label: string; valueKopeks: number };
export type AmountWarning =
  | "not_found" | "negative" | "zero" | "multiple_totals" | "looks_like_vat"
  | "looks_like_subtotal" | "looks_like_advance" | "no_numeric_confirmation";

const FINAL_LABEL = /(итого|всего)\s+к\s+оплате|к\s+оплате|сумма\s+к\s+оплате|итого\s+к\s+перечислению/i;
const VAT_LABEL = /в\s*т\.?\s*ч\.?\s*ндс|включая\s+ндс|в\s+том\s+числе\s+ндс|^ндс/i;
const SUBTOTAL_LABEL = /без\s+ндс|сумма\s+без\s+ндс|подытог|промежуточн/i;
const ADVANCE_LABEL = /аванс|предоплат/i;

/** Pick the FINAL payable amount from labelled candidates and warn on the classic confusions
 *  (VAT / subtotal / advance / multiple totals / negative / zero). Never invents a value. */
export function selectPayableAmount(candidates: AmountCandidate[]): { valueKopeks: number | null; warnings: AmountWarning[] } {
  const warnings: AmountWarning[] = [];
  if (candidates.length === 0) return { valueKopeks: null, warnings: ["not_found"] };
  const finals = candidates.filter((c) => FINAL_LABEL.test(c.label) && !VAT_LABEL.test(c.label));
  const chosen = finals[0] ?? candidates[0];
  if (finals.length === 0) {
    // No explicit "к оплате" label — the fallback might be a VAT/subtotal/advance line.
    if (VAT_LABEL.test(chosen.label)) warnings.push("looks_like_vat");
    if (SUBTOTAL_LABEL.test(chosen.label)) warnings.push("looks_like_subtotal");
    if (ADVANCE_LABEL.test(chosen.label)) warnings.push("looks_like_advance");
  }
  const distinctFinals = new Set(finals.map((c) => c.valueKopeks));
  if (distinctFinals.size > 1) warnings.push("multiple_totals");
  if (chosen.valueKopeks < 0) warnings.push("negative");
  if (chosen.valueKopeks === 0) warnings.push("zero");
  return { valueKopeks: chosen.valueKopeks, warnings };
}

/** Amount doubt that must BLOCK payment until reviewed (§16): missing, non-positive, or a
 *  likely VAT/subtotal/advance mistaken for the total. */
export function amountBlocksPayment(warnings: AmountWarning[]): boolean {
  return warnings.some((w) => ["not_found", "negative", "zero", "looks_like_vat", "looks_like_subtotal", "looks_like_advance", "multiple_totals"].includes(w));
}
