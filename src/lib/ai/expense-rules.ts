// Post-recognition expense category + confidence rules.
//
// The AI sometimes mislabels small consumables (bags, covers, packaging) as
// "investments" with high confidence, or reports high confidence on a photo
// that actually contains two receipts. These deterministic guards correct the
// category and cap the confidence after extraction.
//
// Pure module (no imports) so it is unit-testable in isolation.

export type Confidence = "low" | "medium" | "high";

// Small consumables / household items. Roots cover пакет, майка-пакет, крышка,
// стакан, салфетка, хозтовары, уборка, расходники, канцелярия, бытовая химия.
// Deliberately NOT matching "бытовая техника" (that is equipment/investments).
const CONSUMABLE_PATTERNS: RegExp[] = [
  /пакет/i,
  /майк/i,
  /крышк/i,
  /стакан/i,
  /салфет/i,
  /хоз/i,
  /уборк/i,
  /расходник/i,
  /канцеляр/i,
  /хими/i,
];

/** True when any item looks like a small consumable / household good. */
export function hasConsumableItems(items: string[]): boolean {
  return items.some((item) => CONSUMABLE_PATTERNS.some((re) => re.test(item)));
}

export const WARNING_INVESTMENTS_TO_HOUSEHOLD =
  "Категория исправлена: мелкие расходники относятся к хозрасходам, а не вложениям";
export const WARNING_MULTIPLE_RECEIPTS =
  "На фото несколько чеков, проверьте сумму и позиции вручную";
export const WARNING_ITEMS_UNCLEAR =
  "ИИ не смог уверенно распознать позиции товара. Проверьте чек вручную.";
export const WARNING_CATEGORY_UNKNOWN = "Категория расхода не определена";

// Fake placeholder item names the model sometimes invents ("Товар 1", "Item 2",
// "Позиция 3", dashes, n/a). These must NOT be saved as real items.
const PLACEHOLDER_ITEM_PATTERNS: RegExp[] = [
  /^товар\s*№?\s*\d*$/i,
  /^позици(я|и)\s*№?\s*\d*$/i,
  /^строка\s*№?\s*\d*$/i,
  /^наименование\s*№?\s*\d*$/i,
  /^item\s*#?\s*\d*$/i,
  /^product\s*#?\s*\d*$/i,
  /^[—–-]+$/,
  /^n\/?a$/i,
  /^нет данных$/i,
];

/** True when an item is a placeholder / has no real content. */
export function isPlaceholderItem(item: string): boolean {
  const t = item.trim();
  if (!t) return true;
  return PLACEHOLDER_ITEM_PATTERNS.some((re) => re.test(t));
}

/** Drops placeholder items. Reports whether any were dropped. */
export function cleanReceiptItems(items: string[]): { items: string[]; droppedPlaceholders: boolean } {
  const kept = items.filter((i) => !isPlaceholderItem(i));
  return { items: kept, droppedPlaceholders: kept.length < items.length };
}

// Fiscal cash-receipt markers: a document carrying these is a receipt, not manual.
// NB: JS \b is ASCII-only, so use letter lookarounds for the Cyrillic ФН/ФД/ФП.
const FISCAL_MARKER_PATTERNS: RegExp[] = [
  /кассовый\s*чек/i,
  /(?<![А-Яа-яЁёA-Za-z])Ф[НДП](?![А-Яа-яЁёA-Za-z])/,
  /ИНН\s*продавца/i,
];

/** True when text shows fiscal receipt markers (Кассовый чек, ФН, ФД, ФП, ИНН продавца). */
export function hasFiscalMarkers(text: string): boolean {
  if (!text) return false;
  return FISCAL_MARKER_PATTERNS.some((re) => re.test(text));
}

/** One step down the confidence ladder. */
export function downgradeConfidence(c: Confidence): Confidence {
  return c === "high" ? "medium" : "low";
}

/** Multiple receipts in one image must never be high confidence. */
export function capConfidenceNotHigh(c: Confidence): Confidence {
  return c === "high" ? "medium" : c;
}

export type ExpenseRuleResult = {
  category: string | null;
  confidence: Confidence;
  warnings: string[];
};

/**
 * Applies category correction and confidence caps after AI extraction:
 *  - consumables filed as "investments" -> "household" (+ downgrade + warning)
 *  - consumables with no stronger category (null/other) -> "household"
 *  - multiple receipts in one image -> never high (+ warning)
 *
 * Returns the corrected category/confidence and any warnings to merge in.
 */
export function applyExpenseRules(input: {
  category: string | null;
  confidence: Confidence;
  items: string[];
  multipleReceipts: boolean;
}): ExpenseRuleResult {
  let category = input.category;
  let confidence = input.confidence;
  const warnings: string[] = [];

  const consumable = hasConsumableItems(input.items);

  if (consumable && category === "investments") {
    // Investments is reserved for capital/large purchases, not consumables.
    category = "household";
    confidence = downgradeConfidence(confidence);
    warnings.push(WARNING_INVESTMENTS_TO_HOUSEHOLD);
  } else if (consumable && (category === null || category === "other")) {
    // Consumable items, but no stronger evidence for another category.
    category = "household";
  }

  if (input.multipleReceipts) {
    confidence = capConfidenceNotHigh(confidence);
    warnings.push(WARNING_MULTIPLE_RECEIPTS);
  }

  return { category, confidence, warnings };
}
