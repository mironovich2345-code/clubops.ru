// Phase 1 refund foundation — pure, server-safe helpers (no server-only imports)
// so both the loader/actions AND the pilot can use/mirror them. Return types,
// document slots (stable keys validated against the type) and bank-requisite
// normalization/validation live here as the single source of truth.

export const REFUND_RETURN_TYPES = ["membership", "personal_training"] as const;
export type RefundReturnType = (typeof REFUND_RETURN_TYPES)[number];
export const REFUND_RETURN_TYPE_LABELS: Record<RefundReturnType, string> = {
  membership: "Абонемент",
  personal_training: "Персональные тренировки",
};
export function isRefundReturnType(v: string): v is RefundReturnType {
  return (REFUND_RETURN_TYPES as readonly string[]).includes(v);
}

export type RefundSlot = { key: string; label: string };

// Four mandatory slots per type. Stable keys; the 2nd/3rd contract page use
// DISTINCT documentType keys so they can never collide.
const MEMBERSHIP_SLOTS: RefundSlot[] = [
  { key: "contract_page_1", label: "Первая страница договора" },
  { key: "contract_page_3", label: "Третья страница договора" },
  { key: "refund_application", label: "Заявление на возврат" },
  { key: "payment_receipt", label: "Чек оплаты" },
];
const PERSONAL_TRAINING_SLOTS: RefundSlot[] = [
  { key: "contract_page_1", label: "Первая страница договора" },
  { key: "contract_page_2", label: "Вторая страница договора" },
  { key: "refund_application", label: "Заявление на возврат" },
  { key: "payment_receipt", label: "Чек оплаты" },
];

export function refundSlots(returnType: string): RefundSlot[] {
  if (returnType === "membership") return MEMBERSHIP_SLOTS;
  if (returnType === "personal_training") return PERSONAL_TRAINING_SLOTS;
  return [];
}

/** A documentType is valid ONLY if it is a slot of the given return type. */
export function isValidRefundDocumentType(returnType: string, documentType: string): boolean {
  return refundSlots(returnType).some((s) => s.key === documentType);
}

/** True when all four slots of the type have an active document. */
export function isRefundDocumentSetComplete(returnType: string, activeTypes: readonly string[]): boolean {
  const slots = refundSlots(returnType);
  if (slots.length === 0) return false;
  const set = new Set(activeTypes);
  return slots.every((s) => set.has(s.key));
}

// --- Bank requisites --------------------------------------------------------
// UI may format with spaces; the SERVER normalizes and stores digits only for
// the numeric fields. We NEVER accept card number / CVC / expiry / passport etc.

export type RefundRequisitesInput = {
  bankRecipientName?: string | null;
  bankName?: string | null;
  bankBik?: string | null;
  bankAccount?: string | null;
  bankCorrAccount?: string | null;
};
export type RefundRequisites = {
  bankRecipientName: string;
  bankName: string;
  bankBik: string;
  bankAccount: string;
  bankCorrAccount: string;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const digitsOnly = (s: string) => s.replace(/\D+/g, "");

export type RequisitesResult = { ok: true; data: RefundRequisites } | { ok: false; error: string };

/** Validate + normalize the five requisite fields (Russian BIK/account rules). */
export function validateRefundRequisites(input: RefundRequisitesInput): RequisitesResult {
  const name = collapse(String(input.bankRecipientName ?? ""));
  if (!name) return { ok: false, error: "Укажите ФИО получателя." };
  const bank = collapse(String(input.bankName ?? ""));
  if (!bank) return { ok: false, error: "Укажите банк." };
  const bik = digitsOnly(String(input.bankBik ?? ""));
  if (!/^\d{9}$/.test(bik)) return { ok: false, error: "БИК должен содержать 9 цифр." };
  const account = digitsOnly(String(input.bankAccount ?? ""));
  if (!/^\d{20}$/.test(account)) return { ok: false, error: "Расчётный счёт должен содержать 20 цифр." };
  const corr = digitsOnly(String(input.bankCorrAccount ?? ""));
  if (!/^\d{20}$/.test(corr)) return { ok: false, error: "Корреспондентский счёт должен содержать 20 цифр." };
  return { ok: true, data: { bankRecipientName: name, bankName: bank, bankBik: bik, bankAccount: account, bankCorrAccount: corr } };
}

/** Whether a refund already has a complete, valid requisites block. */
export function hasCompleteRequisites(r: RefundRequisitesInput): boolean {
  return validateRefundRequisites(r).ok;
}

export type PartialRequisites = {
  bankRecipientName: string | null;
  bankName: string | null;
  bankBik: string | null;
  bankAccount: string | null;
  bankCorrAccount: string | null;
};

/**
 * Draft save: normalize whatever is provided; a MISSING field is allowed (null),
 * but a PROVIDED numeric field must already be well-formed. Full presence is
 * enforced later at «Далее» (validateRefundRequisites).
 */
export function normalizeRequisitesPartial(input: RefundRequisitesInput): { ok: true; data: PartialRequisites } | { ok: false; error: string } {
  const name = collapse(String(input.bankRecipientName ?? ""));
  const bank = collapse(String(input.bankName ?? ""));
  const bikRaw = String(input.bankBik ?? "").trim();
  const accRaw = String(input.bankAccount ?? "").trim();
  const corrRaw = String(input.bankCorrAccount ?? "").trim();
  const bik = bikRaw ? digitsOnly(bikRaw) : "";
  const acc = accRaw ? digitsOnly(accRaw) : "";
  const corr = corrRaw ? digitsOnly(corrRaw) : "";
  if (bik && !/^\d{9}$/.test(bik)) return { ok: false, error: "БИК должен содержать 9 цифр." };
  if (acc && !/^\d{20}$/.test(acc)) return { ok: false, error: "Расчётный счёт должен содержать 20 цифр." };
  if (corr && !/^\d{20}$/.test(corr)) return { ok: false, error: "Корреспондентский счёт должен содержать 20 цифр." };
  return { ok: true, data: { bankRecipientName: name || null, bankName: bank || null, bankBik: bik || null, bankAccount: acc || null, bankCorrAccount: corr || null } };
}

/** Mask an account/BIK for audit (keep last 4). */
export function maskDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = digitsOnly(value);
  if (d.length <= 4) return "•".repeat(d.length);
  return `••••${d.slice(-4)}`;
}
