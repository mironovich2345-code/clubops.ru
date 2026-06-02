// Invoice document analysis. A clean provider interface with a safe mock
// fallback for local/dev (no AI key). The mock NEVER fabricates business data —
// it returns the empty structure with low confidence so the user fills fields
// manually. A real provider can be plugged in later behind the same interface.

export type InvoiceConfidence = "low" | "medium" | "high";

export type InvoiceExtraction = {
  counterpartyName: string | null;
  counterpartyInn: string | null;
  counterpartyKpp: string | null;
  counterpartyBankName: string | null;
  counterpartyBankBik: string | null;
  counterpartyAccount: string | null;
  counterpartyCorrAccount: string | null;
  amount: number | null; // rubles
  currency: string;
  expenseCategory: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null; // ISO yyyy-mm-dd
  dueDate: string | null; // ISO yyyy-mm-dd
  confidence: InvoiceConfidence;
  missingFields: string[];
  warnings: string[];
  rawTextOrModelOutput: string;
};

export type AnalysisInput = { buffer: Buffer; mime: string; fileName: string };

export interface InvoiceAnalysisProvider {
  readonly name: string;
  analyze(input: AnalysisInput): Promise<InvoiceExtraction>;
}

// Key fields that must all be present (and the document sharp) for high confidence.
const KEY_FIELDS: Array<keyof InvoiceExtraction> = [
  "counterpartyName",
  "amount",
  "counterpartyAccount",
  "counterpartyBankBik",
];

const EMPTY_FIELDS = {
  counterpartyName: null,
  counterpartyInn: null,
  counterpartyKpp: null,
  counterpartyBankName: null,
  counterpartyBankBik: null,
  counterpartyAccount: null,
  counterpartyCorrAccount: null,
  amount: null,
  expenseCategory: null,
  invoiceNumber: null,
  invoiceDate: null,
  dueDate: null,
} as const;

class MockProvider implements InvoiceAnalysisProvider {
  readonly name = "mock";

  async analyze(input: AnalysisInput): Promise<InvoiceExtraction> {
    return {
      ...EMPTY_FIELDS,
      currency: "RUB",
      confidence: "low",
      missingFields: KEY_FIELDS.map(String),
      warnings: [
        "AI-провайдер не настроен (режим разработки). Поля не распознаны — заполните вручную.",
      ],
      rawTextOrModelOutput:
        `Mock-анализ: файл "${input.fileName}" (${input.mime}, ${input.buffer.length} байт). ` +
        "Реальное распознавание не выполнялось.",
    };
  }
}

function getProvider(): InvoiceAnalysisProvider {
  // When a real key is configured, return the real provider here. Until then we
  // always fall back to the mock so the UI works end-to-end in dev/beta.
  // e.g. if (process.env.INVOICE_AI_API_KEY) return new OpenAIInvoiceProvider(...)
  return new MockProvider();
}

/**
 * Downgrades confidence to match how complete the extraction actually is:
 * high only when every key field is present, otherwise medium/low.
 */
function finalizeConfidence(extraction: InvoiceExtraction): InvoiceExtraction {
  const missing = KEY_FIELDS.filter((f) => {
    const v = extraction[f];
    return v === null || v === undefined || v === "";
  }).map(String);

  let confidence = extraction.confidence;
  if (missing.length > 0 && confidence === "high") confidence = "medium";
  if (missing.length >= KEY_FIELDS.length) confidence = "low";

  return { ...extraction, confidence, missingFields: missing };
}

export async function analyzeInvoiceDocument(input: AnalysisInput): Promise<InvoiceExtraction> {
  const provider = getProvider();
  const raw = await provider.analyze(input);
  return finalizeConfidence(raw);
}
