# Invoice AI recognition pipeline

Server-only pipeline that turns an uploaded invoice/document into structured fields
for the `/invoices` upload form. Designed for RU/Railway deployment (no native
binaries) and for **honesty**: it never claims "AI recognized this" when the model
was not actually given readable content.

## Stages

`file_received → mime_validated → file_loaded → (pdf_text_extracted | image_normalized)
→ ai_request_started → ai_response_received → ai_response_parsed
→ normalization_completed → analysis_completed | analysis_failed`

Each stage records only **safe metadata** — never document text, base64, image bytes,
bank details, storage URLs, or the OpenAI key.

## Document preparation (`src/lib/ai/document-input.ts`)

1. **Real MIME by magic bytes** (`detectMime`) — the declared upload type is not
   trusted. Supported: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`.
2. **Images** → passed to OpenAI Vision as `{ kind: "image" }`.
3. **PDF text layer** (`extractPdfText`, via `unpdf` — pure-JS pdfjs, no native
   binary) → if the extracted text is sufficient (`pdfTextSufficiency`: ≥40
   alphanumerics overall and ≥15 per page) it is sent to the model as
   `{ kind: "pdf_text" }`.
4. **Scanned / image-only PDF** (no usable text layer) → **not faked**. Returns
   `{ kind: "unavailable", errorCode: "PDF_RENDER_REQUIRED" }`. This is reported to
   the user as a *technical* preparation limit, distinct from "AI is unsure".
5. **Undecodable / empty** → `FILE_INVALID`.

### Content guard

If the model would receive no text, no rendered pages, and no image bytes, the
pipeline returns a technical error code — it must **never** return a low-confidence
"AI unsure" result in that case, because the model never saw the document.

## What works today vs. what is deferred

| Input | Handled | How |
|-------|---------|-----|
| JPG / PNG / WEBP photo | ✅ | OpenAI Vision |
| Text PDF (1 page) | ✅ | `unpdf` text extraction → text model |
| Text PDF (multi-page) | ✅ | merged text layer, `pageCount` tracked |
| Scanned / photo PDF | ⛔ deferred | `PDF_RENDER_REQUIRED` — see below |

### Why scanned PDFs are deferred (honest limitation)

Rasterizing a scanned PDF to images for Vision needs a PDF→raster capability that is
**not** available as a pure-JS, dependency-free path in this deployment image. Rather
than fake a result, the pipeline stops and reports `PDF_RENDER_REQUIRED`. The user can
still enter the invoice manually with the file attached.

Options to enable scanned-PDF support later (pick one; each changes the deployment
image / cost profile):

1. **Client-side rasterization** — render PDF pages to PNG in the browser with
   `pdf.js` before upload, send images. No server dependency; moves cost to client;
   needs UI work and page-count limits.
2. **`@napi-rs/canvas` + pdf.js on the server** — render pages to raster in-process.
   Adds a native N-API module to the deployment image; verify Railway/RU base image
   compatibility and bundle size.
3. **External render/OCR service** — send the PDF to a rendering or OCR API. Adds an
   egress dependency and a data-processing agreement concern for financial documents
   (RU compliance); evaluate against `docs/COMPLIANCE_RU.md`.

No option is wired in. `PDF_RENDER_REQUIRED` is the current, honest terminal state.

## Model routing (`src/lib/ai/openai-client.ts`)

- Primary: `INVOICE_AI_PRIMARY_MODEL` → `OPENAI_MODEL` → `gpt-4o-mini`.
- Fallback: `INVOICE_AI_FALLBACK_MODEL` → `gpt-4o`.
- Timeout: `INVOICE_AI_TIMEOUT_MS` (default 60000), via `AbortSignal.timeout`.
- Fallback runs **once**, only when the primary result is invalid, missing a critical
  field, low-confidence, conflicting, or has an incomplete multi-page read. No
  infinite retries.
- Provider selection (`AI_PROVIDER`): `openai` (needs `OPENAI_API_KEY`), `ru_ai`
  (placeholder), `mock` (default in dev — no network, deterministic).

## Confidence (`src/lib/ai/invoice-analyzer.ts`)

- `technicalQuality` — how good the *input* was (image/text quality).
- `overallConfidence` — **not** a plain average; weighted by critical fields
  (counterparty, amount, invoice date) via `criticalMissingCount`.
- `fieldConfidence` — per-field.
- A PDF source never gets a hardcoded-low score just for being a PDF.

## Anti-hallucination & security

- Document text is passed to the model as **untrusted data**, with an explicit system
  instruction to ignore any commands embedded in the document (prompt-injection
  defense).
- Strict JSON schema; unknown fields dropped; missing fields → `null` (never invented
  INN/KPP/amounts); supplier ≠ payer; invoice date ≠ due date; totals not re-summed.
- No SSRF: the model never receives a client-supplied URL or storage key; storage keys
  are not trusted. The API key stays server-side (never in the client bundle;
  `unpdf` and the AWS SDK are in `serverExternalPackages`).
- Financial fields are never auto-confirmed — the user reviews before save.

## Pilot / quality harness

`npm run pilot:invoice-ai` exercises the real `unpdf` extractor on synthetic text
PDFs plus static assertions that the old hardcoded "PDF recognition requires
conversion" short-circuit is gone. Runs inside `npm run pilot:full`.
