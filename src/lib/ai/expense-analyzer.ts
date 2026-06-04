// Expense document analysis (receipts / transfer screenshots). Real OpenAI
// Vision when enabled, with a safe mock fallback. Never fabricates data: unknown
// fields are null and the model is told not to invent amounts/dates/items.

import {
  selectedAiProvider,
  isPdf,
  bufferToDataUrl,
  callOpenAIVision,
} from "@/lib/ai/openai-client";

export type ExpenseConfidence = "low" | "medium" | "high";
export type ExpenseDocType = "receipt" | "transfer" | "manual";
export type AnalysisMode = "ai" | "mock";

export type ExpenseExtraction = {
  type: ExpenseDocType;
  vendorName: string | null;
  recipientName: string | null;
  amount: number | null; // rubles
  currency: string;
  expenseCategory: string | null; // category key
  purchaseDate: string | null; // ISO yyyy-mm-dd
  address: string | null;
  items: string[];
  confidence: ExpenseConfidence;
  mode: AnalysisMode;
  missingFields: string[];
  warnings: string[];
  rawTextOrModelOutput: string;
};

export type ExpenseAnalysisInput = { buffer: Buffer; mime: string; fileName: string };

const CATEGORY_KEYS = ["advertising", "household", "builders", "investments", "refunds", "salary", "other"];
const KEY_FIELDS: Array<keyof ExpenseExtraction> = ["amount", "expenseCategory"];

function vStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function vNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/[\s ]/g, "").replace(",", "."));
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
function vType(v: unknown): ExpenseDocType {
  return v === "receipt" || v === "transfer" || v === "manual" ? v : "manual";
}
function vConfidence(v: unknown): ExpenseConfidence {
  return v === "high" || v === "medium" || v === "low" ? v : "low";
}
function vWarnings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}
function vItems(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}
function vCategory(v: unknown, warnings: string[]): string | null {
  const s = vStr(v);
  if (!s) return null;
  if (CATEGORY_KEYS.includes(s)) return s;
  warnings.push("Статья расходов определена неточно — выбрано «Прочее»");
  return "other";
}

export function mapExpenseJson(json: Record<string, unknown>, raw: string): ExpenseExtraction {
  const warnings = vWarnings(json.warnings);
  return {
    type: vType(json.type),
    vendorName: vStr(json.vendorName),
    recipientName: vStr(json.recipientName),
    amount: vNum(json.amount),
    currency: vStr(json.currency) ?? "RUB",
    expenseCategory: vCategory(json.expenseCategory, warnings),
    purchaseDate: vDate(json.purchaseDate),
    address: vStr(json.address),
    items: vItems(json.items),
    confidence: vConfidence(json.confidence),
    mode: "ai",
    missingFields: [],
    warnings,
    rawTextOrModelOutput: raw,
  };
}

function emptyExpense(type: ExpenseDocType, mode: AnalysisMode, warnings: string[], raw: string): ExpenseExtraction {
  return {
    type,
    vendorName: null,
    recipientName: null,
    amount: null,
    currency: "RUB",
    expenseCategory: null,
    purchaseDate: null,
    address: null,
    items: [],
    confidence: "low",
    mode,
    missingFields: KEY_FIELDS.map(String),
    warnings,
    rawTextOrModelOutput: raw,
  };
}

function finalize(extraction: ExpenseExtraction): ExpenseExtraction {
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

const SYSTEM_PROMPT =
  "Ты извлекаешь данные из фото чека или скриншота банковского перевода (Россия). " +
  "Определи type: 'receipt' для чека, 'transfer' для перевода. " +
  "Верни СТРОГО JSON с ключами: type, vendorName (магазин, для чека), recipientName (получатель, для перевода), " +
  "amount (число, рубли), currency, expenseCategory, purchaseDate (YYYY-MM-DD), address, items (массив строк, позиции чека), " +
  "confidence (low|medium|high), warnings (массив строк). " +
  "Если поле не видно — null. НИКОГДА не выдумывай суммы, даты, позиции, реквизиты. " +
  `expenseCategory выбирай ТОЛЬКО из: ${CATEGORY_KEYS.join(", ")}; если не уверен — "other". ` +
  "confidence=high только если сумма и основные поля чётко видны.";

async function openaiAnalyze(input: ExpenseAnalysisInput): Promise<ExpenseExtraction> {
  if (isPdf(input.mime)) {
    return emptyExpense(
      "manual",
      "ai",
      ["PDF recognition requires conversion or text extraction — заполните поля вручную"],
      `PDF "${input.fileName}" не распознаётся напрямую.`,
    );
  }

  const result = await callOpenAIVision({
    system: SYSTEM_PROMPT,
    user: "Извлеки данные чека или перевода из изображения. Верни только JSON.",
    dataUrl: bufferToDataUrl(input.buffer, input.mime),
  });

  if (result.ok) return mapExpenseJson(result.json, result.raw);
  if (result.reason === "parse") {
    return emptyExpense("manual", "ai", ["ИИ вернул некорректный ответ — заполните поля вручную"], result.raw);
  }
  throw new Error(result.message);
}

function mockAnalyze(input: ExpenseAnalysisInput): ExpenseExtraction {
  return emptyExpense(
    "manual",
    "mock",
    ["ИИ не настроен — заполните поля вручную."],
    `Mock: файл "${input.fileName}" (${input.mime}, ${input.buffer.length} байт).`,
  );
}

export async function analyzeExpenseDocument(input: ExpenseAnalysisInput): Promise<ExpenseExtraction> {
  if (selectedAiProvider() === "openai") {
    try {
      return finalize(await openaiAnalyze(input));
    } catch (error) {
      console.error("expense AI analyze failed, using mock", error instanceof Error ? error.message : error);
      const m = mockAnalyze(input);
      m.warnings = ["ИИ не смог обработать документ — заполните поля вручную"];
      return finalize(m);
    }
  }
  return finalize(mockAnalyze(input));
}

/** Empty extraction for manual entry without an uploaded file. */
export function manualExpenseExtraction(): ExpenseExtraction {
  return finalize(emptyExpense("manual", "mock", [], ""));
}
