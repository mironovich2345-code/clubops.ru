// Helpers for the safe "return path" carried when a strategic (owner/GD) user
// opens an Expense / Invoice detail from a multi-Company analytical page. The
// originating page tags a `back` key naming itself; the detail page resolves it
// against a fixed allowlist (never an arbitrary URL) and re-appends only the
// allowlisted strategic filter keys, so the back-link round-trips the user to
// the exact filtered view they came from.

// Filter keys that may be preserved across the open/return round-trip. Anything
// else is dropped. `back` names the origin page; `from`/`to` are date bounds.
const KEEP_KEYS = [
  "scopeMode", "companyId", "city", "clubId", "month", "category", "status",
  "source", "legalEntity", "pay", "entity", "period", "from", "to",
] as const;

// Allowlisted origin pages. The back-link is ALWAYS one of these fixed internal
// paths — the `back` value selects which, it is never used as a URL itself.
const BACK_PATHS: Record<string, { path: string; label: string }> = {
  expenses: { path: "/expenses", label: "К списку" },
  invoices: { path: "/invoices", label: "К списку" },
  "analytics-expenses": { path: "/analytics/expenses", label: "К детализации" },
  payments: { path: "/payments", label: "К календарю" },
};

type SP = Record<string, string | undefined>;

/**
 * Build the `returnTo` query string a strategic row passes to the safe
 * context-switch action. Keeps only allowlisted filter keys from the current
 * page params and stamps the origin `back` key. Result is a query string
 * (leading `?`) or "".
 */
export function buildReturnTo(back: keyof typeof BACK_PATHS | string, sp: SP): string {
  const out = new URLSearchParams();
  for (const k of KEEP_KEYS) {
    const v = sp[k];
    if (v) out.set(k, String(v));
  }
  if (BACK_PATHS[back]) out.set("back", back);
  const s = out.toString();
  return s ? `?${s}` : "";
}

/**
 * Resolve the back-link for a detail page from its own search params. Falls back
 * to a caller-provided default page when no (valid) `back` key is present.
 */
export function safeBackLink(
  sp: SP,
  fallback: { path: string; label: string },
): { href: string; label: string } {
  const dest = sp.back ? BACK_PATHS[sp.back] : undefined;
  const base = dest ?? fallback;
  const out = new URLSearchParams();
  for (const k of KEEP_KEYS) {
    const v = sp[k];
    if (v) out.set(k, String(v));
  }
  const q = out.toString();
  return { href: q ? `${base.path}?${q}` : base.path, label: base.label };
}
