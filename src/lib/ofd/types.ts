// Shared OFD types. Provider-agnostic where possible; Taxcom-specific shapes are
// prefixed Taxcom*. No buyer PII / item lists / raw JSON appear in any of these —
// only the safe fiscal fingerprint fields the MVP needs.

export type OfdSafeCode =
  | "auth_failed"
  | "forbidden"
  | "rate_limited"
  | "kkt_not_found"
  | "no_kkt_found"
  | "shift_not_found"
  | "contract_not_found"
  | "taxcom_method_not_allowed"
  | "taxcom_wrong_current_account"
  | "network"
  | "timeout"
  | "parse_error"
  | "not_configured"
  | "unknown";

export type OfdOperationType = "income" | "income_return";

/** DECRYPTED connection config, held in memory only for the duration of a call.
 * Secrets are never persisted in plaintext and never logged. */
export type OfdConnectionConfig = {
  id: string;
  companyId: string;
  legalEntityId: string | null;
  provider: string;
  serverBaseUrl: string;
  authType: string;
  // Taxcom agreementNumber (договор) — identifies the target ЛК when one login
  // has several organizations. Not a secret and NOT sent at Login; used only to
  // verify, via AccountList, that the expected ЛК is reachable.
  contractNumber: string | null;
  login: string | null;
  password: string | null;
  integrationToken: string | null;
  integratorId: string | null;
};

export type TaxcomKkt = {
  fnNumber: string;
  kktRegNumber?: string | null;
  kktFactoryNumber?: string | null;
  kktName?: string | null;
  outletId?: string | null;
  outletName?: string | null;
  outletAddress?: string | null;
};

export type TaxcomShift = {
  shiftNumber: number;
  dateOpen?: string | null;
  dateClose?: string | null;
  receiptCount?: number | null; // Taxcom's declared receipts in the shift (diagnostics only)
};

/** One agreement (договор / ЛК) from AccountList — SAFE fields only. */
export type TaxcomAccount = {
  agreementNumber: string | null;
  companyName?: string | null;
  inn?: string | null;
  kpp?: string | null;
};

/** AccountList response: the current session's agreement + the available ones. */
export type TaxcomAccountList = {
  currentAgreementNumber: string | null;
  records: TaxcomAccount[];
};

/** One SAFE nomenclature line of a receipt — name + numbers only, never raw JSON
 * and never buyer PII. Populated only when Taxcom actually returns positions. */
export type TaxcomReceiptItem = {
  name: string; // cleaned, length-limited
  normalizedName: string; // for category matching
  quantityMilli: number; // quantity * 1000 (3-decimal precision)
  priceKopeks: number;
  totalKopeks: number;
};

/** Craft of Taxcom DocumentList: the SAFE per-receipt summary (no buyer PII / raw
 * JSON). `items` is present only when the response carried positions. */
export type TaxcomDocumentSummary = {
  fn: string;
  shift: number;
  type?: string | null;
  documentType?: string | null; // Taxcom ФФД тип: "2" open shift, "3" receipt, "5" close shift
  numberInShift?: number | null;
  dateTime: string; // ISO or Taxcom date string
  fd: number; // fiscal document number (fdNumber)
  fpd?: string | null; // fiscal sign (ФПД)
  operationType?: string | null; // accountingType: "Income" | "IncomeReturn" | …
  totalKopeks: number;
  cashKopeks: number;
  electronicKopeks: number;
  items?: TaxcomReceiptItem[]; // safe nomenclature lines, if any
  itemsPresent?: boolean; // true if the source doc carried a positions array (even if empty)
};

/** Optional full document — NOT used in the MVP unless strictly necessary, and
 * never persisted. Kept minimal + safe. */
export type TaxcomDocumentInfo = {
  fn: string;
  fd: number;
  fpd?: string | null;
  operationType?: string | null;
  totalKopeks: number;
  cashKopeks: number;
  electronicKopeks: number;
};

/** The normalized, storable fingerprint of a receipt. */
export type NormalizedOfdReceipt = {
  fnNumber: string;
  shiftNumber: number | null;
  fiscalDocumentNumber: number;
  fiscalSign: string | null;
  operationType: OfdOperationType;
  receiptDate: Date;
  totalKopeks: number;
  cashKopeks: number;
  electronicKopeks: number;
  dedupeKey: string;
  items?: TaxcomReceiptItem[]; // carried through so the importer can persist them
  itemsPresent?: boolean;
};

/** SAFE structural diagnostics for GET /API/v2/NewDocuments — key names + counts
 * ONLY. Never carries document values, raw JSON, ФПД or buyer PII. Used to detect
 * whether Taxcom's NewDocuments endpoint can yield receipt nomenclature. */
export type NewDocumentsShape = {
  topLevelKeys: string[]; // key names of the response envelope
  documentCount: number;
  firstDocumentKeys: string[]; // key names of the first document (names, not values)
  detectedItemLikeKeys: string[]; // item-like paths that hold an array (e.g. "items")
  hasItemsLikeData: boolean;
  documentTypeCounts: Record<string, number>; // safe counts by documentType value
};

/** SAFE structural diagnostics for GET /API/v2/DocumentInfo (one fiscal document)
 * — key names + counts ONLY. Never carries document values, raw JSON, ФПД or PII. */
export type DocumentInfoShape = {
  topLevelKeys: string[]; // key names of the response envelope
  documentKeys: string[]; // key names of the document object (names, not values)
  detectedItemLikeKeys: string[]; // item-like paths that hold an array/object (incl. FFD "document.1059")
  hasItemsLikeData: boolean;
  itemLikeCount: number; // total item-like rows across detected sources (count only)
  firstItemKeys: string[]; // key names of the first position (names, not values)
  numericFfdModeDetected: boolean; // true if the numeric FFD tag 1059 is present
  safeDocumentType: string | null; // documentType value ("3" | …), safe code only
};

export type OfdResult<T> =
  | { ok: true; data: T }
  | { ok: false; safeCode: OfdSafeCode; safeMessage?: string; httpStatus?: number };
