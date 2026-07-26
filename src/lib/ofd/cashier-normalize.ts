// STAGE 13: pure cashier-name normalization + fuzzy scoring. No DB, no eval. The normalized
// form is used ONLY to build match SUGGESTIONS — never as a live payout key. Fuzzy scoring is
// advisory (confidence), never a confirmed match.

/**
 * Safe normalization of a cashier / employee full name (spec §6):
 *   - Unicode NFC, trim, lowercase
 *   - collapse internal whitespace
 *   - ё → е
 *   - drop safe punctuation (dots/commas/quotes) but KEEP the letters
 *   - normalize word order deterministically (sorted tokens) so "Иванов Иван" and
 *     "Иван Иванов" compare equal — WITHOUT dropping any name part
 * Never removes name parts, never reduces to surname-only. Returns "" for empty input.
 */
export function normalizeCashierName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.normalize("NFC").trim().toLowerCase();
  s = s.replace(/ё/g, "е");
  // Replace safe punctuation with spaces (keeps initials as separate tokens).
  s = s.replace(/[.,;:"'`()\[\]{}]/g, " ");
  s = s.replace(/[-–—]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s === "") return "";
  // Deterministic token order (so surname/first-name order doesn't matter) — all parts kept.
  const tokens = s.split(" ").filter(Boolean).sort();
  return tokens.join(" ");
}

/** The comparable set of name tokens (deduped). */
export function nameTokens(normalized: string): string[] {
  return [...new Set(normalized.split(" ").filter(Boolean))];
}

/**
 * Advisory similarity 0..100 between two ALREADY-normalized names — ONLY for suggestions
 * (spec §6/§7). 100 = identical normalized string. Otherwise a conservative token-overlap
 * (Jaccard) score. Single-token (surname-only) overlaps are capped low so they never look
 * like a confident match.
 */
export function nameConfidence(aNorm: string, bNorm: string): number {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 100;
  const a = nameTokens(aNorm);
  const b = nameTokens(bNorm);
  const setB = new Set(b);
  const inter = a.filter((t) => setB.has(t)).length;
  const union = new Set([...a, ...b]).size;
  if (union === 0) return 0;
  const jaccard = Math.round((inter / union) * 100);
  // A one-token overlap (e.g. shared surname only) must not read as confident.
  if (inter <= 1 && (a.length > 1 || b.length > 1)) return Math.min(jaccard, 40);
  return jaccard;
}

/** True only for an EXACT normalized full-name match (the sole auto-match-worthy signal). */
export function isExactNameMatch(aNorm: string, bNorm: string): boolean {
  return aNorm.length > 0 && aNorm === bNorm;
}
