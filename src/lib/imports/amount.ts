// Pure amount parsing/formatting for the plan & budget imports and their UI inputs.
// Accepts human thousands-grouped rubles (spaces / nbsp / thin space / dots / commas)
// and a currency symbol, and returns integer KOPEKS. Plans/budgets don't need kopeck
// precision, so the value is rounded to whole rubles. No I/O — fully testable.

export type AmountParse = { kopeks: number } | { empty: true } | { error: true };

/** Parse a rubles amount string to kopeks. Accepts 2500000, "2 500 000",
 * "2.500.000", "2,500,000", "2 500 000,50", "₽ 2 500 000". Rounds to rubles. */
export function parseImportAmountToKopeks(raw: unknown): AmountParse {
  let s = String(raw ?? "").trim().replace(/₽|руб\.?/gi, "");
  // Strip every kind of whitespace used as a thousands separator (incl nbsp / thin).
  s = s.replace(/\s/g, "");
  if (s === "") return { empty: true };
  if (!/^[\d.,]+$/.test(s)) return { error: true };

  // A trailing "." or "," followed by exactly 1-2 digits is a decimal separator;
  // any other "."/"," is a thousands separator and is stripped.
  let intStr = s;
  let fracStr = "";
  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  if (lastSep !== -1) {
    const after = s.slice(lastSep + 1);
    if (after.length === 1 || after.length === 2) {
      intStr = s.slice(0, lastSep);
      fracStr = after;
    }
  }
  const intDigits = intStr.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intDigits)) return { error: true };
  const rubles = Number(intDigits) + (fracStr ? Number(`0.${fracStr}`) : 0);
  if (!Number.isFinite(rubles) || rubles < 0) return { error: true };
  return { kopeks: Math.round(rubles) * 100 };
}

/** Group an integer with spaces: 2500000 → "2 500 000". */
export function formatThousands(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.trunc(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return neg ? `-${s}` : s;
}

/** Format kopeks as grouped rubles (no kopeck part): 250000000 → "2 500 000 ₽". */
export function formatKopeksThousands(kopeks: number): string {
  return `${formatThousands(Math.round(kopeks / 100))} ₽`;
}
