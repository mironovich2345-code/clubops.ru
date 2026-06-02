// Expense document analysis (receipts / transfer screenshots). Clean provider
// interface with a safe mock fallback for local/dev — the mock NEVER fabricates
// business data: it returns the empty structure with low confidence so the user
// fills fields manually. A real provider can be plugged in behind this interface.

export type ExpenseConfidence = "low" | "medium" | "high";
export type ExpenseDocType = "receipt" | "transfer" | "manual";

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
  missingFields: string[];
  warnings: string[];
  rawTextOrModelOutput: string;
};

export type ExpenseAnalysisInput = { buffer: Buffer; mime: string; fileName: string };

export interface ExpenseAnalysisProvider {
  readonly name: string;
  analyze(input: ExpenseAnalysisInput): Promise<ExpenseExtraction>;
}

const KEY_FIELDS: Array<keyof ExpenseExtraction> = ["amount", "expenseCategory"];

function emptyExtraction(type: ExpenseDocType): ExpenseExtraction {
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
    missingFields: KEY_FIELDS.map(String),
    warnings: [],
    rawTextOrModelOutput: "",
  };
}

class MockExpenseProvider implements ExpenseAnalysisProvider {
  readonly name = "mock";

  async analyze(input: ExpenseAnalysisInput): Promise<ExpenseExtraction> {
    return {
      ...emptyExtraction("manual"),
      warnings: [
        "AI-провайдер не настроен (режим разработки). Поля не распознаны — заполните вручную.",
      ],
      rawTextOrModelOutput:
        `Mock-анализ: файл "${input.fileName}" (${input.mime}, ${input.buffer.length} байт). ` +
        "Реальное распознавание не выполнялось.",
    };
  }
}

function getProvider(): ExpenseAnalysisProvider {
  // Plug a real provider here when a key is configured; mock otherwise.
  return new MockExpenseProvider();
}

function finalizeConfidence(extraction: ExpenseExtraction): ExpenseExtraction {
  const missing = KEY_FIELDS.filter((f) => {
    const v = extraction[f];
    return v === null || v === undefined || v === "";
  }).map(String);

  let confidence = extraction.confidence;
  if (missing.length > 0 && confidence === "high") confidence = "medium";
  if (missing.length >= KEY_FIELDS.length) confidence = "low";

  return { ...extraction, confidence, missingFields: missing };
}

export async function analyzeExpenseDocument(
  input: ExpenseAnalysisInput,
): Promise<ExpenseExtraction> {
  const raw = await getProvider().analyze(input);
  return finalizeConfidence(raw);
}

/** Empty extraction for manual entry without an uploaded file. */
export function manualExpenseExtraction(): ExpenseExtraction {
  return emptyExtraction("manual");
}
