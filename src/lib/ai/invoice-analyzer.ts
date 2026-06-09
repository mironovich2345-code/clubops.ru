// Invoice document analysis. Real OpenAI Vision when enabled, with a safe mock
// fallback. Neither path fabricates data: unknown fields are null, and the model
// is instructed to never invent INN/bank details/amounts/dates. Every AI
// response is parsed through strict validation.

import {
  selectedAiProvider,
  isPdf,
  bufferToDataUrl,
  callOpenAIVision,
} from "@/lib/ai/openai-client";
import { resolveCounterparty } from "@/lib/ai/invoice-party";

export type InvoiceConfidence = "low" | "medium" | "high";
export type AnalysisMode = "ai" | "mock";

export type InvoiceExtraction = {
  counterpartyName: string | null;
  counterpartyInn: string | null;
  counterpartyKpp: string | null;
  counterpartyBankName: string | null;
  counterpartyBankBik: string | null;
  counterpartyAccount: string | null;
  counterpartyCorrAccount: string | null;
  payerName: string | null;
  payerInn: string | null;
  payerKpp: string | null;
  amount: number | null; // rubles
  currency: string;
  expenseCategory: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // ISO yyyy-mm-dd
  dueDate: string | null; // ISO yyyy-mm-dd
  confidence: InvoiceConfidence;
  mode: AnalysisMode;
  missingFields: string[];
  warnings: string[];
  rawTextOrModelOutput: string;
};

export type AnalysisInput = { buffer: Buffer; mime: string; fileName: string };

// Category keys shared with expenses/budgets.
const CATEGORY_KEYS = ["advertising", "household", "builders", "rent", "investments", "refunds", "salary", "other"];

// Key fields required for high confidence (incl. amount + bank details).
const KEY_FIELDS: Array<keyof InvoiceExtraction> = [
  "counterpartyName",
  "amount",
  "counterpartyAccount",
  "counterpartyBankBik",
];

// --- value validation (anti-hallucination normalization) ---------------------

function vStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function vNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[\s ]/g, "").replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}
function vDate(v: unknown): string | null {
  const s = vStr(v);
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return null;
}
function vConfidence(v: unknown): InvoiceConfidence {
  return v === "high" || v === "medium" || v === "low" ? v : "low";
}
function vWarnings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}
function vCategory(v: unknown, warnings: string[]): string | null {
  const s = vStr(v);
  if (!s) return null;
  if (CATEGORY_KEYS.includes(s)) return s;
  warnings.push("Статья расходов определена неточно — выбрано «Прочее»");
  return "other";
}

/** Builds a validated InvoiceExtraction from raw model JSON. */
export function mapInvoiceJson(json: Record<string, unknown>, raw: string): InvoiceExtraction {
  const warnings = vWarnings(json.warnings);

  // Counterparty must be the supplier/recipient, not the payer.
  const party = resolveCounterparty({
    counterpartyName: vStr(json.counterpartyName),
    supplierName: vStr(json.supplierName),
    payerName: vStr(json.payerName),
  });
  let confidence = vConfidence(json.confidence);
  if (party.payerConflict) {
    warnings.push("Возможно, ИИ выбрал плательщика вместо поставщика");
    confidence = "low";
  }

  return {
    counterpartyName: party.counterpartyName,
    counterpartyInn: vStr(json.counterpartyInn),
    counterpartyKpp: vStr(json.counterpartyKpp),
    counterpartyBankName: vStr(json.counterpartyBankName),
    counterpartyBankBik: vStr(json.counterpartyBankBik),
    counterpartyAccount: vStr(json.counterpartyAccount),
    counterpartyCorrAccount: vStr(json.counterpartyCorrAccount),
    payerName: vStr(json.payerName),
    payerInn: vStr(json.payerInn),
    payerKpp: vStr(json.payerKpp),
    amount: vNum(json.amount),
    currency: vStr(json.currency) ?? "RUB",
    expenseCategory: vCategory(json.expenseCategory, warnings),
    invoiceNumber: vStr(json.invoiceNumber),
    invoiceDate: vDate(json.invoiceDate),
    dueDate: vDate(json.dueDate),
    confidence,
    mode: "ai",
    missingFields: [],
    warnings,
    rawTextOrModelOutput: raw,
  };
}

function emptyInvoice(mode: AnalysisMode, warnings: string[], raw: string): InvoiceExtraction {
  return {
    counterpartyName: null,
    counterpartyInn: null,
    counterpartyKpp: null,
    counterpartyBankName: null,
    counterpartyBankBik: null,
    counterpartyAccount: null,
    counterpartyCorrAccount: null,
    payerName: null,
    payerInn: null,
    payerKpp: null,
    amount: null,
    currency: "RUB",
    expenseCategory: null,
    invoiceNumber: null,
    invoiceDate: null,
    dueDate: null,
    confidence: "low",
    mode,
    missingFields: KEY_FIELDS.map(String),
    warnings,
    rawTextOrModelOutput: raw,
  };
}

/** Recomputes missing key fields and downgrades confidence to match completeness. */
function finalize(extraction: InvoiceExtraction): InvoiceExtraction {
  const missing = KEY_FIELDS.filter((f) => {
    const v = extraction[f];
    return v === null || v === undefined || v === "";
  }).map(String);

  let confidence = extraction.confidence;
  if (missing.length > 0 && confidence === "high") confidence = "medium";
  if (missing.length >= KEY_FIELDS.length) confidence = "low";

  const warnings = [...extraction.warnings];
  if (extraction.mode === "ai" && confidence === "low") {
    const msg = "ИИ не смог уверенно распознать документ — проверьте поля вручную";
    if (!warnings.includes(msg)) warnings.push(msg);
  }

  return { ...extraction, confidence, missingFields: missing, warnings };
}

// --- providers ---------------------------------------------------------------

const SYSTEM_PROMPT =
  "Ты извлекаешь данные из изображения российского счёта на оплату для учёта РАСХОДА. " +
  "ВАЖНО: counterpartyName — это ПОСТАВЩИК / получатель оплаты (кому платят), " +
  "НЕ плательщик, НЕ покупатель, НЕ наша компания. " +
  "Бери counterparty и ВСЕ банковские реквизиты (ИНН, КПП, банк, БИК, р/с, корр/с) ТОЛЬКО из полей: " +
  "Поставщик, Получатель, Исполнитель, Продавец, Организация-получатель, Реквизиты получателя. " +
  "НИКОГДА не бери как counterparty поля: Плательщик, Покупатель, Заказчик, Клиент, Наша организация. " +
  "Если в документе есть и Поставщик, и Плательщик — counterpartyName и реквизиты бери у ПОСТАВЩИКА/ПОЛУЧАТЕЛЯ, " +
  "а Плательщика игнорируй для полей counterparty. " +
  "Дополнительно верни отдельно данные ПЛАТЕЛЬЩИКА: supplierName (Поставщик/Получатель), " +
  "payerName (Плательщик), payerInn (ИНН плательщика), payerKpp (КПП плательщика) — для проверки. " +
  "Реквизиты плательщика (payerInn/payerKpp) НЕ путай с реквизитами counterparty. " +
  "Верни СТРОГО JSON-объект с ключами: counterpartyName, supplierName, payerName, payerInn, payerKpp, " +
  "counterpartyInn, counterpartyKpp, " +
  "counterpartyBankName, counterpartyBankBik, counterpartyAccount, counterpartyCorrAccount, " +
  "amount (число, рубли), currency, expenseCategory, invoiceNumber, invoiceDate (YYYY-MM-DD), " +
  "dueDate (YYYY-MM-DD), confidence (low|medium|high), warnings (массив строк). " +
  "Если поле не видно или не уверено — верни null. НИКОГДА не выдумывай ИНН, банковские реквизиты, " +
  "даты, суммы. Если сумма или банковские реквизиты неточны — confidence не выше medium. " +
  `expenseCategory выбирай ТОЛЬКО из: ${CATEGORY_KEYS.join(", ")}; если не уверен — "other". ` +
  "confidence=high только если все ключевые поля чётко видны.";

async function openaiAnalyze(input: AnalysisInput): Promise<InvoiceExtraction> {
  if (isPdf(input.mime)) {
    return emptyInvoice(
      "ai",
      ["PDF recognition requires conversion or text extraction — заполните поля вручную"],
      `PDF "${input.fileName}" не распознаётся напрямую.`,
    );
  }

  const result = await callOpenAIVision({
    system: SYSTEM_PROMPT,
    user: "Извлеки данные счёта из изображения. Верни только JSON.",
    dataUrl: bufferToDataUrl(input.buffer, input.mime),
  });

  if (result.ok) return mapInvoiceJson(result.json, result.raw);
  if (result.reason === "parse") {
    return emptyInvoice("ai", ["ИИ вернул некорректный ответ — заполните поля вручную"], result.raw);
  }
  // config/http/network -> let the caller fall back to mock.
  throw new Error(result.message);
}

function mockAnalyze(input: AnalysisInput): InvoiceExtraction {
  return emptyInvoice(
    "mock",
    ["ИИ не настроен — заполните поля вручную."],
    `Mock: файл "${input.fileName}" (${input.mime}, ${input.buffer.length} байт).`,
  );
}

export async function analyzeInvoiceDocument(input: AnalysisInput): Promise<InvoiceExtraction> {
  if (selectedAiProvider() === "openai") {
    try {
      return finalize(await openaiAnalyze(input));
    } catch (error) {
      console.error("invoice AI analyze failed, using mock", error instanceof Error ? error.message : error);
      const m = mockAnalyze(input);
      m.warnings = ["ИИ не смог обработать документ — заполните поля вручную"];
      return finalize(m);
    }
  }
  return finalize(mockAnalyze(input));
}
