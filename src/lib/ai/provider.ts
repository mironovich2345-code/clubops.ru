// Document-analysis provider contract.
//
// The app exposes three entry points used by the upload flows:
//   - analyzeInvoiceDocument  (src/lib/ai/invoice-analyzer.ts)
//   - analyzeExpenseDocument  (src/lib/ai/expense-analyzer.ts)
//   - analyzeRefundDocuments  (src/lib/ai/refund-analyzer.ts)
//
// They dispatch on selectedAiProvider():
//   - "openai" — dev/test only. Sends images to OpenAI (data leaves RU).
//   - "ru_ai"  — production target. A Russian AI/OCR provider implements the
//                interface below and is wired in behind the "ru_ai" branch.
//                Not implemented yet; analyzers fall back to mock.
//   - "mock"   — safe default, no external calls.
//
// This interface is the seam a Russian provider must satisfy; nothing else in
// the app needs to change when it is added.

import type { AnalysisInput, InvoiceExtraction } from "@/lib/ai/invoice-analyzer";
import type { ExpenseAnalysisInput, ExpenseExtraction } from "@/lib/ai/expense-analyzer";
import type { RefundAnalysisInput, RefundExtraction } from "@/lib/ai/refund-analyzer";

export interface DocumentAiProvider {
  readonly name: string;
  analyzeInvoice(input: AnalysisInput): Promise<InvoiceExtraction>;
  analyzeExpense(input: ExpenseAnalysisInput): Promise<ExpenseExtraction>;
  /** Refunds may carry several documents (contract, statement, requisites…). */
  analyzeRefund(inputs: RefundAnalysisInput[]): Promise<RefundExtraction>;
}
