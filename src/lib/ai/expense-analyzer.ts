// Expense document analysis (receipts / transfer screenshots). Real OpenAI
// Vision when enabled, with a safe mock fallback. Never fabricates data: unknown
// fields are null and the model is told not to invent amounts/dates/items.

import {
  selectedAiProvider,
  isPdf,
  bufferToDataUrl,
  callOpenAIVision,
} from "@/lib/ai/openai-client";
import {
  applyExpenseRules,
  cleanReceiptItems,
  hasFiscalMarkers,
  WARNING_ITEMS_UNCLEAR,
  WARNING_CATEGORY_UNKNOWN,
} from "@/lib/ai/expense-rules";

export type ExpenseConfidence = "low" | "medium" | "high";
export type ExpenseDocType = "receipt" | "transfer" | "manual";
export type AnalysisMode = "ai" | "mock";

export type ExpenseExtraction = {
  type: ExpenseDocType;
  vendorName: string | null;
  recipientName: string | null;
  transferComment: string | null;
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

/** True when the model signals more than one receipt/document in the image. */
function multipleDocsFlag(json: Record<string, unknown>): boolean {
  if (json.multipleReceipts === true || json.multipleReceipts === "true") return true;
  const docs = vNum(json.documentsCount);
  const receipts = vNum(json.receiptsCount);
  return (docs !== null && docs > 1) || (receipts !== null && receipts > 1);
}

export function mapExpenseJson(json: Record<string, unknown>, raw: string): ExpenseExtraction {
  const warnings = vWarnings(json.warnings);
  const pushWarn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  const vendorName = vStr(json.vendorName);
  const recipientName = vStr(json.recipientName);
  const transferComment =
    vStr(json.transferComment) ?? vStr(json.paymentPurpose) ?? vStr(json.purpose);
  let type = vType(json.type);
  let confidence = vConfidence(json.confidence);

  // Part 1: never keep fake placeholder items ("Товар 1", "Item 2", …). If the
  // model only produced placeholders, treat items as unrecognized.
  const cleaned = cleanReceiptItems(vItems(json.items));
  const items = cleaned.items;
  if (cleaned.droppedPlaceholders && items.length === 0) {
    confidence = "low";
    pushWarn(WARNING_ITEMS_UNCLEAR);
  }

  // Fiscal markers (Кассовый чек / ФН / ФД / ФП / ИНН продавца) => receipt.
  const fiscalText = [vendorName, ...items, vStr(json.address), raw].filter(Boolean).join(" ");
  if (type !== "transfer" && (json.hasFiscalMarkers === true || hasFiscalMarkers(fiscalText))) {
    type = "receipt";
  }

  // Consumable/multi-receipt guards (existing rules).
  const ruled = applyExpenseRules({
    category: vCategory(json.expenseCategory, warnings),
    confidence,
    items,
    multipleReceipts: multipleDocsFlag(json),
  });
  for (const w of ruled.warnings) pushWarn(w);
  confidence = ruled.confidence;

  // Part 1/2: uncertain category stays null (do not guess) + warning.
  if (ruled.category === null) pushWarn(WARNING_CATEGORY_UNKNOWN);

  return {
    type,
    vendorName,
    recipientName,
    transferComment,
    amount: vNum(json.amount),
    currency: vStr(json.currency) ?? "RUB",
    expenseCategory: ruled.category,
    purchaseDate: vDate(json.purchaseDate),
    address: vStr(json.address),
    items,
    confidence,
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
    transferComment: null,
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
  "transferComment (назначение/комментарий перевода, для type=transfer), " +
  "amount (число, рубли), currency, expenseCategory, purchaseDate (YYYY-MM-DD), address, items (массив строк, позиции чека), " +
  "multipleReceipts (true/false — видно ли на фото больше одного чека/документа), " +
  "hasFiscalMarkers (true/false — есть ли признаки кассового чека: «Кассовый чек», ФН, ФД, ФП, ИНН продавца), " +
  "confidence (low|medium|high), warnings (массив строк). " +
  "Если поле не видно — null. НИКОГДА не выдумывай суммы, даты, позиции, реквизиты. " +
  // --- Items rules ----------------------------------------------------------
  "items: только реально читаемые позиции. НИКОГДА не придумывай «Товар 1», «Товар 2», «Item 1», «Позиция 1» — " +
  "если позиции не читаются, верни items=[] и понизь confidence. " +
  // --- Document type rules --------------------------------------------------
  "Если в документе есть «Кассовый чек», ФН, ФД, ФП или ИНН продавца — type=receipt (не manual). " +
  "Если документ — подтверждение перевода: type=transfer, заполни recipientName и transferComment (назначение платежа); " +
  "vendorName можно оставить null. Для перевода категорию определяй ТОЛЬКО по transferComment, если он понятен; " +
  "если комментарий отсутствует или неясен — expenseCategory=null. " +
  // --- Category rules -------------------------------------------------------
  `expenseCategory выбирай ТОЛЬКО из: ${CATEGORY_KEYS.join(", ")}. Правила: ` +
  "advertising — реклама, реклама ВК/VK, Яндекс реклама, таргет, продвижение, рекламные материалы. " +
  "household — хозтовары, пакеты, майка-пакеты, крышки, стаканы, салфетки, бытовая химия, расходники, уборка, " +
  "канцелярия, мелкие товары для клуба/офиса. " +
  "builders — ремонт, стройматериалы, инструменты, подрядчики ремонта, сантехника, электрика. " +
  "investments — ТОЛЬКО крупные капитальные покупки и долгосрочные активы: тренажёры, оборудование, мебель, " +
  "техника для клуба, крупные вложения. НЕ используй investments для мелких расходников, упаковки, пакетов, " +
  "крышек, канцелярии — это household. " +
  "refunds — возвраты клиентам. salary — зарплата, аванс, премия, выплаты сотрудникам. " +
  "other — когда не уверен. " +
  // --- Confidence rules -----------------------------------------------------
  "confidence=high СТАВЬ ТОЛЬКО ЕСЛИ: на фото ровно один чек/перевод; сумма однозначна; дата однозначна; " +
  "продавец/получатель однозначен; категория очевидна; нет конкурирующих сумм или других документов. " +
  "Понижай до medium или low если: на фото несколько чеков; видно несколько итоговых сумм; фото повёрнуто/" +
  "обрезано/размыто; категория выведена из позиций, а не указана явно; сумма может относиться к другому чеку; " +
  "распознана только часть документа. " +
  "Если на фото несколько чеков/документов (multipleReceipts=true) — confidence ОБЯЗАТЕЛЬНО low или medium, " +
  "НИКОГДА не high, и добавь в warnings: «На фото несколько чеков, проверьте сумму и позиции вручную».";

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
