// REM-07 — safe-metadata allowlist + log-injection guard (spec §21/§22). PURE.
// Security events must NEVER carry secrets, PII, documents, signed URLs or raw
// bodies. Only allow-listed keys survive; every value is sanitized (no newlines/
// control chars, truncated) and secret-looking values are dropped.

// Keys that are safe to store in metadataJson. Anything else is discarded.
export const SAFE_METADATA_KEYS = new Set<string>([
  "entityType",
  "targetType",
  "role",
  "roles",
  "capability",
  "page",
  "action",
  "reasonCode",
  "status",
  "fromStatus",
  "toStatus",
  "amountKopeks",
  "amountBand",
  "count",
  "limiterSource",
  "ipTrusted",
  "failOpen",
  "outcome",
  "provider",
  "attempt",
  "legalEntityType",
  "scope",
  "method",
]);

// Value patterns that look sensitive → dropped regardless of key.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const SECRET_RE = /^[A-Za-z0-9/+=_-]{24,}$/; // long high-entropy-ish token
const URL_RE = /https?:\/\//i;

/** Replace any control char (< 0x20 or 0x7F) with a space — kills log injection
 * (newlines/CR) without a literal-control-char regex in source. */
function stripControl(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x20 || c === 0x7f ? " " : s[i];
  }
  return out;
}

/** Sanitize a single primitive value: strip control chars, truncate, drop if sensitive. */
export function sanitizeValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = stripControl(String(v)).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (EMAIL_RE.test(s) || URL_RE.test(s) || SECRET_RE.test(s)) return "[redacted]";
  return s.slice(0, 200);
}

/**
 * Build a redacted, allow-listed metadata object. Unknown keys are dropped; values
 * are sanitized. Returns a plain object safe to JSON.stringify into the event.
 */
export function redactMetadata(input: Record<string, unknown> | undefined | null): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input) return out;
  for (const [k, raw] of Object.entries(input)) {
    if (!SAFE_METADATA_KEYS.has(k)) continue;
    if (Array.isArray(raw)) {
      out[k] = sanitizeValue(raw.map((x) => sanitizeValue(x)).filter((x) => x !== null).join(","));
    } else {
      out[k] = sanitizeValue(raw);
    }
  }
  return out;
}

/** Map an exact amount to a coarse band (for events where the exact value is not needed). */
export function amountBand(amountKopeks: number): string {
  const rub = Math.abs(amountKopeks) / 100;
  if (rub === 0) return "0";
  if (rub < 1000) return "<1k";
  if (rub < 10000) return "1k-10k";
  if (rub < 100000) return "10k-100k";
  if (rub < 1000000) return "100k-1M";
  return ">=1M";
}

/** Redacted email → stable non-reversible short marker (never the address). */
export function emailMarker(email: string | null | undefined): string | null {
  if (!email) return null;
  let h = 0;
  const lower = email.toLowerCase();
  for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) >>> 0;
  return `email#${h.toString(16)}`;
}
