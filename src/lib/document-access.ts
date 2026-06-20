// Helpers for serving supporting accounting documents (receipts, invoices,
// КМ-6, encashment/withdrawal/refund files). Authorization stays in each route
// (object-level getXForContext + storage-key validation); these helpers only
// decide inline-vs-attachment and de-dupe the access audit.
import type { Role } from "@/lib/auth";
import { canDownloadDocuments } from "@/lib/auth";

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
