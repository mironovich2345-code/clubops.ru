// Refund document analysis (contract / statement / requisites / receipt).
// Clean provider interface with a safe mock fallback — the mock NEVER fabricates
// business data: it returns the empty structure with low confidence so the user
// fills fields manually. A real provider plugs in behind this interface.

export type RefundConfidence = "low" | "medium" | "high";

export type RefundExtraction = {
  clientName: string | null;
  clientPhone: string | null;
  amount: number | null; // rubles
  currency: string;
  reason: string | null;
  contractNumber: string | null;
  refundDate: string | null; // ISO yyyy-mm-dd
  bankRecipientName: string | null;
  bankName: string | null;
  bankBik: string | null;
  bankAccount: string | null;
  confidence: RefundConfidence;
  missingFields: string[];
  warnings: string[];
  rawTextOrModelOutput: string;
};

export type RefundAnalysisInput = { buffer: Buffer; mime: string; fileName: string };

export interface RefundAnalysisProvider {
  readonly name: string;
  analyze(inputs: RefundAnalysisInput[]): Promise<RefundExtraction>;
}

const KEY_FIELDS: Array<keyof RefundExtraction> = ["clientName", "amount", "bankAccount"];

function emptyExtraction(): RefundExtraction {
  return {
    clientName: null,
    clientPhone: null,
    amount: null,
    currency: "RUB",
    reason: null,
    contractNumber: null,
    refundDate: null,
    bankRecipientName: null,
    bankName: null,
    bankBik: null,
    bankAccount: null,
    confidence: "low",
    missingFields: KEY_FIELDS.map(String),
    warnings: [],
    rawTextOrModelOutput: "",
  };
}

class MockRefundProvider implements RefundAnalysisProvider {
  readonly name = "mock";

  async analyze(inputs: RefundAnalysisInput[]): Promise<RefundExtraction> {
    const names = inputs.map((i) => i.fileName).join(", ") || "нет файлов";
    return {
      ...emptyExtraction(),
      warnings: [
        "AI-провайдер не настроен (режим разработки). Поля не распознаны — заполните вручную.",
      ],
      rawTextOrModelOutput: `Mock-анализ документов (${inputs.length}): ${names}. Реальное распознавание не выполнялось.`,
    };
  }
}

function getProvider(): RefundAnalysisProvider {
  // Plug a real provider here when a key is configured; mock otherwise.
  return new MockRefundProvider();
}

function finalizeConfidence(extraction: RefundExtraction): RefundExtraction {
  const missing = KEY_FIELDS.filter((f) => {
    const v = extraction[f];
    return v === null || v === undefined || v === "";
  }).map(String);

  let confidence = extraction.confidence;
  if (missing.length > 0 && confidence === "high") confidence = "medium";
  if (missing.length >= KEY_FIELDS.length) confidence = "low";

  return { ...extraction, confidence, missingFields: missing };
}

export async function analyzeRefundDocuments(
  inputs: RefundAnalysisInput[],
): Promise<RefundExtraction> {
  const raw = await getProvider().analyze(inputs);
  return finalizeConfidence(raw);
}

/** Empty extraction for manual entry without uploaded files. */
export function manualRefundExtraction(): RefundExtraction {
  return emptyExtraction();
}
