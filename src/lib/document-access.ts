// Helpers for serving supporting accounting documents (receipts, invoices,
// КМ-6, encashment/withdrawal/refund files). Authorization stays in each route
// (object-level getXForContext + storage-key validation); these helpers only
// decide inline-vs-attachment, derive a SAFE content type, and de-dupe the audit.
import type { Role } from "@/lib/auth";
import { canDownloadDocuments } from "@/lib/auth";

// Content type is derived from the SERVER-GENERATED storage-key extension, never
// from the client-declared MIME (which is untrusted on legacy v1 uploads). Only
// these types render inline; anything else (svg, html, xhtml, office, csv, heic,
// unknown) is forced to an attachment download. Combined with X-Content-Type-
// Options: nosniff this prevents a document from being served as executable HTML.
const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf",
};
const INLINE_SAFE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);

function keyExtension(storageKey: string): string {
  const dot = storageKey.lastIndexOf(".");
  return dot >= 0 ? storageKey.slice(dot + 1).toLowerCase() : "";
}

/** Whether a storage key's (server-set) extension is safe to preview inline. */
export function isInlineSafeKey(storageKey: string): boolean {
  return INLINE_SAFE_EXTS.has(keyExtension(storageKey));
}

/**
 * Safe response headers for streaming a stored document. The Content-Type is
 * derived from the storage-key extension (an allowlist), NOT the client MIME;
 * anything outside the inline allowlist — or when the accounting contour asks to
 * download — is served as an attachment. Always sets nosniff + private no-store.
 */
export function safeDownloadHeaders(storageKey: string, fileName: string, forceAttachment: boolean): Record<string, string> {
  const ext = keyExtension(storageKey);
  const inlineOk = INLINE_SAFE_EXTS.has(ext);
  const contentType = EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";
  const disposition = forceAttachment || !inlineOk ? "attachment" : "inline";
  return {
    "Content-Type": contentType,
    "Content-Disposition": `${disposition}; filename="${encodeURIComponent(fileName || "document")}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

/**
 * Magic-byte sniff for the legacy image/PDF upload paths (jpg/png/webp/pdf only).
 * Returns the detected MIME or null. PDF detection scans the first 1 KiB so a
 * PDF with a short leading preamble still validates. Used to REJECT an upload
 * whose bytes are not a real image/PDF (e.g. HTML/SVG/script disguised by a
 * declared image MIME), independent of the download-time hardening above.
 */
export function sniffDocumentSignature(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.subarray(0, 1024).indexOf("%PDF-") >= 0) return "application/pdf";
  return null;
}

/**
 * Whether this request should be served as an explicit download (attachment).
 * Only the accounting contour (see canDownloadDocuments) may download via
 * `?download=1`; every other role always gets inline viewing regardless of the
 * query param.
 */
export function wantsAttachment(req: Request, roles: readonly Role[]): boolean {
  const requested = new URL(req.url).searchParams.get("download") === "1";
  return requested && canDownloadDocuments(roles);
}

/** Content-Disposition header value (inline by default, attachment for download). */
export function dispositionHeader(attachment: boolean, fileName: string): string {
  const kind = attachment ? "attachment" : "inline";
  return `${kind}; filename="${encodeURIComponent(fileName)}"`;
}

/**
 * De-dupes the access audit against browser range requests: PDF/image viewers
 * issue many partial `Range` fetches for one open. Only the initial request
 * (no Range, or `bytes=0-…`) is auditable, so a single open/download yields one
 * audit row instead of dozens.
 */
export function isInitialDocumentRequest(req: Request): boolean {
  const range = req.headers.get("range");
  return !range || /^bytes=0-/.test(range);
}
