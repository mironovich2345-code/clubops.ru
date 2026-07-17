// Pure revenue-category logic for OFD nomenclature. No I/O, no regex (safe against
// heavy expressions), fully testable. Maps a receipt item name to one of the five
// CLUB-OPS revenue categories via DB rules (priority) with an in-code fallback.

/** The five OFD revenue categories used by CLUB-OPS. */
export const OFD_REVENUE_CATEGORIES: { code: string; name: string }[] = [
  { code: "membership", name: "Абонементы" },
  { code: "personal_training", name: "Персональные тренировки" },
  { code: "group_training", name: "Групповые тренировки" },
  { code: "extra_services", name: "Доп. услуги" },
  { code: "other", name: "Иное" },
];

export const OFD_OTHER_CATEGORY = { code: "other", name: "Иное" } as const;

const CATEGORY_NAME = new Map(OFD_REVENUE_CATEGORIES.map((c) => [c.code, c.name]));
export function revenueCategoryName(code: string): string {
  return CATEGORY_NAME.get(code) ?? "Иное";
}

export type MatchType = "contains" | "starts_with" | "exact";

/** Normalize a name for matching: NFKC, strip control/invisible chars, ё→е,
 * collapse whitespace, trim, lower-case. Deterministic and cheap. */
export function normalizeItemName(v: string | null | undefined): string {
  return (v ?? "")
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_ITEM_NAME = 200;
/** Clean an item name for DISPLAY/storage: NFKC, strip control chars, collapse
 * whitespace, trim, length-limit. Keeps original case. Never stores raw JSON. */
export function cleanItemName(v: string | null | undefined): string {
  const s = (v ?? "")
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, MAX_ITEM_NAME);
}

/** In-code fallback rules. DB rules always take priority over these. Order matters
 * for a first-match within this list: the broad membership "карта" is intentionally
 * LAST so extra-service / training patterns win first. No "bar" category. */
export const DEFAULT_CATEGORY_RULES: { code: string; name: string; matchType: MatchType; pattern: string }[] = [
  ...["групповая тренировка", "групповые тренировки", "групповое занятие", "групповые занятия", "мини-группа", "мини группа"].map((pattern) => ({ code: "group_training", name: "Групповые тренировки", matchType: "contains" as MatchType, pattern })),
  { code: "group_training", name: "Групповые тренировки", matchType: "starts_with", pattern: "гт" },
  ...["персональная тренировка", "персональные тренировки", "тренировка с тренером", "индивидуальная тренировка", "индивидуальные тренировки"].map((pattern) => ({ code: "personal_training", name: "Персональные тренировки", matchType: "contains" as MatchType, pattern })),
  { code: "personal_training", name: "Персональные тренировки", matchType: "starts_with", pattern: "пт" },
  ...["заморозка", "продление", "переоформление", "восстановление карты", "аренда", "полотенце", "шкафчик", "солярий", "доп услуга", "дополнительная услуга"].map((pattern) => ({ code: "extra_services", name: "Доп. услуги", matchType: "contains" as MatchType, pattern })),
  ...["клубная карта", "абонемент", "членство", "карта"].map((pattern) => ({ code: "membership", name: "Абонементы", matchType: "contains" as MatchType, pattern })),
];

function matchRule(matchType: string, normalizedPattern: string, normalizedName: string): boolean {
  if (!normalizedPattern) return false;
  if (matchType === "starts_with") return normalizedName.startsWith(normalizedPattern);
  if (matchType === "exact") return normalizedName === normalizedPattern;
  return normalizedName.includes(normalizedPattern); // "contains" (default)
}

export type OfdCategoryRuleLike = {
  id?: string | null;
  legalEntityId?: string | null;
  categoryCode: string;
  categoryName: string;
  matchType: string;
  pattern?: string;
  normalizedPattern?: string;
  priority?: number;
  isActive?: boolean;
  createdAt?: Date | string;
};

export type OfdCategoryResult = { code: string; name: string; ruleId: string | null };

/**
 * Categorize one normalized item name. DB rules first (company-wide OR matching the
 * given legalEntity), sorted legalEntity-specific → priority DESC → createdAt ASC;
 * then the in-code fallback; then "other". A matched DB rule returns its ruleId.
 */
export function categorizeItem(normalizedName: string, dbRules: OfdCategoryRuleLike[] = [], legalEntityId: string | null = null): OfdCategoryResult {
  if (!normalizedName) return { ...OFD_OTHER_CATEGORY, ruleId: null };
  const applicable = dbRules.filter((r) => r.isActive !== false && (r.legalEntityId == null || r.legalEntityId === legalEntityId));
  const sorted = [...applicable].sort((a, b) => {
    const aSpec = a.legalEntityId ? 1 : 0, bSpec = b.legalEntityId ? 1 : 0;
    if (aSpec !== bSpec) return bSpec - aSpec; // legalEntity-specific first
    const ap = a.priority ?? 0, bp = b.priority ?? 0;
    if (ap !== bp) return bp - ap; // priority DESC
    return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")); // createdAt ASC
  });
  for (const r of sorted) {
    const pat = r.normalizedPattern ?? normalizeItemName(r.pattern);
    if (matchRule(r.matchType, pat, normalizedName)) return { code: r.categoryCode, name: r.categoryName, ruleId: r.id ?? null };
  }
  for (const fb of DEFAULT_CATEGORY_RULES) {
    if (matchRule(fb.matchType, normalizeItemName(fb.pattern), normalizedName)) return { code: fb.code, name: fb.name, ruleId: null };
  }
  return { ...OFD_OTHER_CATEGORY, ruleId: null };
}
