// Pure, client-safe format checks for legal-entity requisites. Warnings only —
// they never block saving (per spec). Empty values are not warned.

const RULES: Record<string, { re: RegExp; msg: string }> = {
  // ООО -> 10 digits, ИП -> 12 digits.
  inn: { re: /^(\d{10}|\d{12})$/, msg: "ИНН должен содержать 10 или 12 цифр" },
  kpp: { re: /^\d{9}$/, msg: "КПП должен содержать 9 цифр" },
  bankBik: { re: /^\d{9}$/, msg: "БИК должен содержать 9 цифр" },
  accountNumber: { re: /^\d{20}$/, msg: "Расчётный счёт должен содержать 20 цифр" },
  corrAccount: { re: /^\d{20}$/, msg: "Корр. счёт должен содержать 20 цифр" },
};

/** Returns a warning string when a non-empty value looks invalid, else null. */
export function legalEntityFieldWarning(field: string, value: string | null | undefined): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const rule = RULES[field];
  if (!rule) return null;
  return rule.re.test(v) ? null : rule.msg;
}
