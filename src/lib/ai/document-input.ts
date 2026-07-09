// Safe normalization of an uploaded financial document into a typed input for
// the AI analyzer. Server-only. NEVER logs document content. Real MIME is checked
// by magic bytes (the file extension / declared type is not trusted). Text PDFs
// are extracted with unpdf (pure-JS pdfjs — no native binary, Railway/RU-safe);
// scanned PDFs (no usable text) are reported as a technical, page-render
// requirement — they are NOT silently downgraded to "AI unsure".
import { extractText, getDocumentProxy } from "unpdf";

export type DocSourceMode = "image" | "pdf_text" | "pdf_vision" | "unavailable";
export type DocErrorCode = null | "FILE_INVALID" | "DOCUMENT_CONTENT_UNAVAILABLE" | "PDF_RENDER_REQUIRED";

export type AnalysisStage =
  | "file_received" | "mime_validated" | "file_loaded" | "pdf_text_extracted"
  | "pdf_pages_rendered" | "image_normalized" | "ai_request_started"
  | "ai_response_received" | "ai_response_parsed" | "normalization_completed"
  | "analysis_completed" | "analysis_failed";

export type DocumentAnalysisInput =
  | { kind: "image"; sourceMode: "image"; mimeType: string; bytes: Buffer }
  | { kind: "pdf_text"; sourceMode: "pdf_text"; extractedText: string; pageCount: number }
  | { kind: "unavailable"; sourceMode: "unavailable"; errorCode: DocErrorCode };

// Safe diagnostics — metadata only, never document content / base64 / secrets.
export type DocDiagnostics = {
  fileType: string;
  sizeBytes: number;
  pageCount: number;
  textLength: number;
  imageCount: number;
  sourceMode: DocSourceMode;
  errorCode: DocErrorCode;
  stages: Array<{ stage: AnalysisStage; ok: boolean }>;
};

/** Detect the real MIME from magic bytes (declared type is not trusted). */
export function detectMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Extract a merged text layer + page count from a PDF (pure JS). */
export async function extractPdfText(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const res = await extractText(doc, { mergePages: true });
  const raw: unknown = res.text;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("\n") : "";
  return { text: text.trim(), pageCount: res.totalPages ?? 0 };
}

/** Classify whether an extracted PDF text layer is meaningful enough to use. */
export function pdfTextSufficiency(text: string, pageCount: number): { sufficient: boolean; alnum: number; perPage: number; textLength: number } {
  const clean = text.replace(/\s+/g, " ").trim();
  const alnum = (clean.match(/[\p{L}\p{N}]/gu) || []).length;
  const perPage = pageCount > 0 ? alnum / pageCount : alnum;
  // Enough letters/digits overall AND per page → a real text layer (not a scan).
  const sufficient = alnum >= 40 && perPage >= 15;
  return { sufficient, alnum, perPage: Math.round(perPage), textLength: clean.length };
}

/**
 * Prepare a normalized analysis input + safe diagnostics. Never sends empty
 * content to a model: an image that won't decode → FILE_INVALID; a PDF whose
 * text can't be extracted → PDF_RENDER_REQUIRED (a technical page-render need,
 * documented in AI_PIPELINE.md), never a false "AI unsure".
 */
export async function prepareDocumentInput(buffer: Buffer, declaredMime: string, _fileName: string): Promise<{ input: DocumentAnalysisInput; diagnostics: DocDiagnostics }> {
  const stages: DocDiagnostics["stages"] = [{ stage: "file_received", ok: true }];
  const detected = detectMime(buffer);
  const fileType = detected ?? declaredMime ?? "unknown";
  const base: DocDiagnostics = { fileType, sizeBytes: buffer.length, pageCount: 0, textLength: 0, imageCount: 0, sourceMode: "unavailable", errorCode: null, stages };

  if (!detected || buffer.length === 0) {
    stages.push({ stage: "mime_validated", ok: false }, { stage: "analysis_failed", ok: false });
    return { input: { kind: "unavailable", sourceMode: "unavailable", errorCode: "FILE_INVALID" }, diagnostics: { ...base, errorCode: "FILE_INVALID" } };
  }
  stages.push({ stage: "mime_validated", ok: true });

  if (IMAGE_MIME.has(detected)) {
    stages.push({ stage: "file_loaded", ok: true }, { stage: "image_normalized", ok: true });
    return { input: { kind: "image", sourceMode: "image", mimeType: detected, bytes: buffer }, diagnostics: { ...base, imageCount: 1, sourceMode: "image" } };
  }

  // PDF: try the text layer.
  let text = "", pageCount = 0;
  try {
    const r = await extractPdfText(buffer);
    text = r.text; pageCount = r.pageCount;
    stages.push({ stage: "file_loaded", ok: true }, { stage: "pdf_text_extracted", ok: true });
  } catch {
    stages.push({ stage: "pdf_text_extracted", ok: false }, { stage: "analysis_failed", ok: false });
    return { input: { kind: "unavailable", sourceMode: "unavailable", errorCode: "FILE_INVALID" }, diagnostics: { ...base, errorCode: "FILE_INVALID" } };
  }

  const suff = pdfTextSufficiency(text, pageCount);
  if (suff.sufficient) {
    return { input: { kind: "pdf_text", sourceMode: "pdf_text", extractedText: text, pageCount }, diagnostics: { ...base, pageCount, textLength: suff.textLength, sourceMode: "pdf_text" } };
  }
  // No usable text layer → this is a scanned PDF that needs page rasterization
  // (a native/system capability not enabled here). Honest technical outcome.
  stages.push({ stage: "pdf_pages_rendered", ok: false });
  return { input: { kind: "unavailable", sourceMode: "unavailable", errorCode: "PDF_RENDER_REQUIRED" }, diagnostics: { ...base, pageCount, textLength: suff.textLength, errorCode: "PDF_RENDER_REQUIRED" } };
}
