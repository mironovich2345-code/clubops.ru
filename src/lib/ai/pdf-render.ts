// Server-only PDF → PNG renderer for scanned invoices. Uses the system
// `pdftoppm` (poppler-utils) — a mature, GUI-less binary on PATH — rather than a
// native node canvas package, so Next.js standalone file-tracing can never lose
// it (it is installed in the Docker image, not node_modules). The PDF is piped in
// via stdin and the PNG is read from stdout, so NEITHER the document NOR the
// rendered image is ever written to disk. The base64/bytes are never logged.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type PdfRenderResult =
  | { ok: true; png: Buffer; durationMs: number }
  | { ok: false; reason: "unavailable" | "timeout" | "too_large" | "error"; durationMs: number };

// Render only the FIRST page: invoice requisites are on page 1, and rendering one
// page keeps memory/latency bounded (never rasterise a 200-page PDF).
export const PDF_RENDER_PAGE = 1;
export const PDF_RENDER_DPI = 150; // enough for OCR of a page-size invoice
export const PDF_RENDER_TIMEOUT_MS = 20_000;
export const PDF_RENDER_MAX_PNG_BYTES = 8 * 1024 * 1024; // cap the output image

/** Build the pdftoppm argv: single first page, PNG, stdin (`-`) → stdout (`-`). */
export function pdftoppmArgs(dpi: number = PDF_RENDER_DPI): string[] {
  return ["-png", "-singlefile", "-f", String(PDF_RENDER_PAGE), "-l", String(PDF_RENDER_PAGE), "-r", String(dpi), "-", "-"];
}

// Injectable spawn so the pipeline can be tested without poppler installed.
export type SpawnLike = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

/**
 * Render the first page of a PDF to a PNG buffer (in memory). Returns a typed
 * result — never throws. `unavailable` means poppler is not installed (spawn
 * ENOENT); `timeout` means the render exceeded the deadline; `too_large` means
 * the PNG exceeded the size cap; `error` is any other non-zero exit.
 */
export async function renderPdfFirstPageToPng(
  pdf: Buffer,
  opts?: { dpi?: number; timeoutMs?: number; maxBytes?: number; spawnImpl?: SpawnLike },
): Promise<PdfRenderResult> {
  const dpi = opts?.dpi ?? PDF_RENDER_DPI;
  const timeoutMs = opts?.timeoutMs ?? PDF_RENDER_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? PDF_RENDER_MAX_PNG_BYTES;
  const spawnImpl: SpawnLike = opts?.spawnImpl ?? ((cmd, args) => spawn(cmd, args) as ChildProcessWithoutNullStreams);
  const start = Date.now();

  return new Promise<PdfRenderResult>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl("pdftoppm", pdftoppmArgs(dpi));
    } catch {
      resolve({ ok: false, reason: "unavailable", durationMs: Date.now() - start });
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let overflow = false;

    const finish = (r: PdfRenderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: "timeout", durationMs: Date.now() - start }), timeoutMs);

    // Spawn failure (e.g. poppler not installed → ENOENT).
    child.on("error", () => finish({ ok: false, reason: "unavailable", durationMs: Date.now() - start }));

    child.stdout.on("data", (d: Buffer) => {
      total += d.length;
      if (total > maxBytes) { overflow = true; finish({ ok: false, reason: "too_large", durationMs: Date.now() - start }); return; }
      chunks.push(d);
    });
    // Never log stderr (could echo content); consume it so the pipe does not stall.
    child.stderr.on("data", () => { /* discarded */ });

    child.on("close", (code) => {
      if (overflow) return;
      const png = Buffer.concat(chunks);
      if (code === 0 && png.length > 0) finish({ ok: true, png, durationMs: Date.now() - start });
      else finish({ ok: false, reason: "error", durationMs: Date.now() - start });
    });

    // Feed the PDF via stdin (nothing touches disk), then close the stream.
    try {
      child.stdin.on("error", () => { /* EPIPE if the child died early — handled by close/error */ });
      child.stdin.write(pdf);
      child.stdin.end();
    } catch {
      finish({ ok: false, reason: "error", durationMs: Date.now() - start });
    }
  });
}
