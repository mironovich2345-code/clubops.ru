// Payroll statement (зарплатная ведомость) analysis.
//
// PERSONAL DATA: payroll statements contain employee names and salaries. They
// must NOT be sent to OpenAI in production. analyzePayrollDocument blocks the
// OpenAI path when NODE_ENV=production (manual entry stays available) and only
// uses OpenAI for dev/test. A Russian AI/OCR provider is the production target.

import {
  selectedAiProvider,
  isPdf,
  bufferToDataUrl,
  callOpenAIVision,
} from "@/lib/ai/openai-client";

export type Confidence = "low" | "medium" | "high";
export type PayrollMode = "ai" | "mock";

export type PayrollRowExtraction = {
  employeeName: string | null;
  role: string | null;
  amount: number | null; // rubles
  isSigned: boolean;
  signatureConfidence: Confidence;
};

export type PayrollExtraction = {
  period: string | null;
  rows: PayrollRowExtraction[];
  confidence: Confidence;
  mode: PayrollMode;
  // True when AI was deliberately blocked (personal data in production).
  blocked: boolean;
  warnings: string[];
  rawTextOrModelOutput: string;
};

export type PayrollAnalysisInput = { buffer: Buffer; mime: string; fileName: string };

export const WARNING_SIGNATURE_UNCLEAR = "Подпись по строке не определена уверенно";
export const WARNING_PAYROLL_AI_BLOCKED =
  "Зарплатные ведомости содержат персональные данные. Для боевого режима нужен российский AI/OCR-провайдер.";
export const MESSAGE_NO_NEW_SIGNED_ROWS = "Новых подписанных строк не найдено";

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
function vConfidence(v: unknown): Confidence {
  return v === "high" || v === "medium" || v === "low" ? v : "low";
}
function vBool(v: unknown): boolean {
  return v === true || v === "true";
}

function emptyPayroll(mode: PayrollMode, blocked: boolean, warnings: string[], raw: string): PayrollExtraction {
  return { period: null, rows: [], confidence: "low", mode, blocked, warnings, rawTextOrModelOutput: raw };
}

export function mapPayrollJson(json: Record<string, unknown>, raw: string): PayrollExtraction {
  const warnings = Array.isArray(json.warnings)
    ? json.warnings.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  const rawRows = Array.isArray(json.rows) ? json.rows : [];

  let anyUnclear = false;
  const rows: PayrollRowExtraction[] = rawRows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    const signatureConfidence = vConfidence(row.signatureConfidence);
    let isSigned = vBool(row.isSigned);
    // Unclear signature (low confidence) is treated as NOT signed.
    if (signatureConfidence === "low") {
      if (isSigned) anyUnclear = true;
      isSigned = false;
    }
    return {
      employeeName: vStr(row.employeeName),
      role: vStr(row.role),
      amount: vNum(row.amount),
      isSigned,
      signatureConfidence,
    };
  });

  if (anyUnclear && !warnings.includes(WARNING_SIGNATURE_UNCLEAR)) {
    warnings.push(WARNING_SIGNATURE_UNCLEAR);
  }

  return {
    period: vStr(json.period),
    rows,
    confidence: rows.length > 0 ? vConfidence(json.confidence) : "low",
    mode: "ai",
    blocked: false,
    warnings,
    rawTextOrModelOutput: raw,
  };
}

const SYSTEM_PROMPT =
  "Ты извлекаешь строки зарплатной ведомости (Россия). Верни СТРОГО JSON с ключами: " +
  "period (строка периода или null), rows (массив объектов), confidence (low|medium|high), warnings (массив строк). " +
  "Каждый объект rows: employeeName (ФИО или null), role (должность или null), amount (число, рубли), " +
  "isSigned (true/false — есть ли подпись напротив строки), signatureConfidence (low|medium|high). " +
  "Подпись считается ТОЛЬКО если она реально видна. Если подпись неясна — isSigned=false и signatureConfidence=low. " +
  "НИКОГДА не выдумывай ФИО и суммы. Если строка не читается — пропусти её.";

async function openaiAnalyze(input: PayrollAnalysisInput): Promise<PayrollExtraction> {
  if (isPdf(input.mime)) {
    return emptyPayroll("ai", false, ["PDF не распознаётся напрямую — заполните строки вручную"], `PDF "${input.fileName}"`);
  }
  const result = await callOpenAIVision({
    system: SYSTEM_PROMPT,
    user: "Извлеки строки зарплатной ведомости из изображения. Верни только JSON.",
    dataUrl: bufferToDataUrl(input.buffer, input.mime),
  });
  if (result.ok) return mapPayrollJson(result.json, result.raw);
  if (result.reason === "parse") {
    return emptyPayroll("ai", false, ["ИИ вернул некорректный ответ — заполните строки вручную"], result.raw);
  }
  throw new Error(result.message);
}

/**
 * Analyzes a payroll statement image. In production with AI_PROVIDER=openai the
 * AI path is BLOCKED (personal data) and an empty manual extraction is returned
 * with a warning. OpenAI is used only outside production; otherwise mock.
 */
export async function analyzePayrollDocument(input: PayrollAnalysisInput): Promise<PayrollExtraction> {
  const provider = selectedAiProvider();
  const isProduction = process.env.NODE_ENV === "production";

  if (provider === "openai" && isProduction) {
    return emptyPayroll("mock", true, [WARNING_PAYROLL_AI_BLOCKED], "AI blocked for payroll in production");
  }

  if (provider === "openai") {
    try {
      return await openaiAnalyze(input);
    } catch (error) {
      console.error("payroll AI analyze failed, manual mode", error instanceof Error ? error.message : error);
      return emptyPayroll("mock", false, ["ИИ не смог обработать ведомость — заполните строки вручную"], "");
    }
  }

  // mock / ru_ai (not yet implemented): manual entry.
  return emptyPayroll("mock", false, ["ИИ не настроен — заполните строки вручную."], "");
}

/** Empty extraction for manual payroll entry (no file). */
export function manualPayrollExtraction(): PayrollExtraction {
  return emptyPayroll("mock", false, [], "");
}
