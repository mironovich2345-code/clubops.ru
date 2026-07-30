// Helpers for serving supporting accounting documents (receipts, invoices,
// КМ-6, encashment/withdrawal/refund files). Authorization stays in each route
// (object-level getXForContext + storage-key validation); these helpers only
// decide inline-vs-attachment, derive a SAFE content type, and de-dupe the audit.
import { NextResponse } from "next/server";
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
  const kind = forceAttachment || !inlineOk ? "attachment" : "inline";
  return {
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition(kind, fileName || "document"),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

/** Content-Type from the server-set storage-key extension (allowlist). */
export function keyContentType(storageKey: string): string {
  return EXT_CONTENT_TYPE[keyExtension(storageKey)] ?? "application/octet-stream";
}

/**
 * RFC 6266 Content-Disposition value. A non-ASCII (e.g. Cyrillic) filename must NOT
 * go raw into the header (invalid bytes) nor be blanket `encodeURIComponent`d (that
 * eats the extension and shows `%D0…` to the user). We emit an ASCII fallback that
 * keeps the extension PLUS a `filename*=UTF-8''` copy with the real name.
 */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const name = fileName || "document";
  const fallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "document";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Build a document response with HTTP range support. Advertises `Accept-Ranges: bytes`
 * and answers a single `Range: bytes=a-b` with a 206 (some inline PDF viewers — notably
 * iOS Safari — request ranges and won't render without them). No Range → full 200.
 */
export function documentResponse(
  req: Request,
  bytes: Buffer,
  opts: { contentType: string; disposition: string },
): NextResponse {
  const total = bytes.length;
  const base: Record<string, string> = {
    "Content-Type": opts.contentType,
    "Content-Disposition": opts.disposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
  };
  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      return new NextResponse(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${total}` } });
    }
    end = Math.min(end, total - 1);
    const chunk = bytes.subarray(start, end + 1);
    return new NextResponse(new Uint8Array(chunk), {
      status: 206,
      headers: { ...base, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(chunk.length) },
    });
  }
  return new NextResponse(new Uint8Array(bytes), { status: 200, headers: { ...base, "Content-Length": String(total) } });
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
  return contentDisposition(attachment ? "attachment" : "inline", fileName);
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
