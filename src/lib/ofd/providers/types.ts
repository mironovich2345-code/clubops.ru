// OFD provider abstraction. The existing Taxcom code already normalizes fiscal docs to
// NormalizedOfdReceipt; this interface generalizes that contract so a second provider
// (Astral.ОФД) can plug in and reuse ALL downstream aggregation/analytics unchanged.
// The schema already carries a `provider` column everywhere — no model changes needed.
import type { OfdConnectionConfig, NormalizedOfdReceipt } from "@/lib/ofd/types";

export type OfdTestConnectionResult =
  | { ok: true; organization?: string | null; cashRegisters?: Array<{ fnNumber: string; name?: string | null }> }
  | { ok: false; code: string; message: string };

/** A provider integration status the UI/settings can surface honestly. */
export type OfdProviderStatus = "live" | "ready_for_credentials" | "blocked_by_documentation" | "blocked_by_access" | "blocked_by_credentials";

export interface OfdProvider {
  /** Stable provider id — matches the `provider` column (e.g. "taxcom", "astral"). */
  readonly id: string;
  /** Human label. */
  readonly label: string;
  /** Integration status — never "live" until a real request with real credentials succeeded. */
  readonly status: OfdProviderStatus;
  /**
   * Minimal safe check: authorize + read the organization / cash-register list WITHOUT
   * importing any data. Returns a precise error code on failure.
   */
  testConnection(config: OfdConnectionConfig): Promise<OfdTestConnectionResult>;
}

/** Providers normalize their raw fiscal documents to this shared DTO. */
export type NormalizeReceipt<TRaw> = (raw: TRaw, provider: string) => NormalizedOfdReceipt;

/** Provider-prefixed dedupe key (mirrors the Taxcom rule, generalized). */
export function buildProviderDedupeKey(provider: string, fnNumber: string, fiscalDocumentNumber: number, fiscalSign: string | null | undefined): string {
  return fiscalSign
    ? `${provider}:${fnNumber}:${fiscalDocumentNumber}:${fiscalSign}`
    : `${provider}:${fnNumber}:${fiscalDocumentNumber}`;
}
