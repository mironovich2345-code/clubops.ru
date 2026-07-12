// Document-download security regression (stored-XSS hardening). Verifies that the
// four legacy v1 file routes derive a SAFE Content-Type from the server-generated
// storage-key extension (never the client MIME), force non-inline types to a
// download, always set nosniff, and that legacy image/PDF uploads reject bytes
// that are not a real jpg/png/webp/pdf. Mirrors the pure helpers + statically
// asserts the real routes/persisters. npm run pilot:document-security
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// --- Mirror of lib/document-access.ts safe helpers -------------------------
const EXT_CONTENT_TYPE = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };
const INLINE = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);
const ext = (k) => { const d = k.lastIndexOf("."); return d >= 0 ? k.slice(d + 1).toLowerCase() : ""; };
function safeDownloadHeaders(storageKey, fileName, forceAttachment) {
  const e = ext(storageKey);
  const inlineOk = INLINE.has(e);
  const contentType = EXT_CONTENT_TYPE[e] ?? "application/octet-stream";
  const disposition = forceAttachment || !inlineOk ? "attachment" : "inline";
  return { "Content-Type": contentType, "Content-Disposition": `${disposition}; filename="${encodeURIComponent(fileName || "document")}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" };
}
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.subarray(0, 1024).indexOf("%PDF-") >= 0) return "application/pdf";
  return null;
}

// === Safe headers: content type NEVER text/html, unknown → attachment ===
{
  // A malicious HTML upload can only ever have a server-set safe extension.
  const png = safeDownloadHeaders("invoices/" + "a".repeat(32) + ".png", "x.png", false);
  check("1 text/html is impossible — png key serves image/png", png["Content-Type"] === "image/png");
  check("1b png renders inline", png["Content-Disposition"].startsWith("inline"));
  check("2 nosniff always set", png["X-Content-Type-Options"] === "nosniff");
  check("3 pdf inline as application/pdf", safeDownloadHeaders("invoices/x.pdf", "d.pdf", false)["Content-Type"] === "application/pdf");
  check("3b jpg/jpeg/webp inline with image type", ["invoices/x.jpg", "invoices/x.jpeg", "refunds/x.webp"].every((k) => safeDownloadHeaders(k, "f", false)["Content-Disposition"].startsWith("inline")));
  // Non-allowlisted extensions (svg/html/xls/csv/heic/unknown) → attachment + octet-stream.
  for (const e of ["svg", "html", "xhtml", "js", "xls", "xlsx", "csv", "heic", "exe", "zip", "unknownext"]) {
    const h = safeDownloadHeaders("sales-reports/x." + e, "f." + e, false);
    check(`4 ${e} → attachment`, h["Content-Disposition"].startsWith("attachment"));
    check(`4b ${e} → octet-stream (not the type)`, h["Content-Type"] === "application/octet-stream");
  }
  check("5 accounting download forces attachment even for pdf", safeDownloadHeaders("invoices/x.pdf", "f", true)["Content-Disposition"].startsWith("attachment"));
}

// === Magic-byte sniff: reject markup/script, accept real docs ===
{
  const html = Buffer.from("<html><script>alert(1)</script></html>", "utf8");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
  check("6 HTML bytes rejected", sniff(html) === null);
  check("7 SVG bytes rejected", sniff(svg) === null);
  check("8 real PNG accepted", sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])) === "image/png");
  check("8b real JPEG accepted", sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === "image/jpeg");
  check("8c real WEBP accepted", sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")])) === "image/webp");
  check("8d real PDF accepted (even with short preamble)", sniff(Buffer.from("\n%PDF-1.7\n...")) === "application/pdf");
  check("8e empty/garbage rejected", sniff(Buffer.from([0x00, 0x01, 0x02])) === null);
}

// === Static assertions on the real routes + persisters ===
const routes = [
  "src/app/api/invoices/[id]/file/route.ts",
  "src/app/api/expenses/[id]/file/route.ts",
  "src/app/api/refunds/[id]/file/route.ts",
  "src/app/api/sales-reports/[id]/file/route.ts",
];
for (const r of routes) {
  const src = read(r);
  const name = r.split("/").slice(-3, -2)[0];
  check(`S ${name} uses safeDownloadHeaders`, /safeDownloadHeaders\(/.test(src));
  check(`S ${name} does NOT echo a stored client MIME in the response`, !/"Content-Type":\s*\w+\.(originalFileMime|mime|mimeType)/.test(src));
  check(`S ${name} scope-checks via getXForContext`, /get\w+ForContext\(/.test(src));
}
const da = read("src/lib/document-access.ts");
check("S da nosniff + inline allowlist", da.includes('"X-Content-Type-Options": "nosniff"') && da.includes("INLINE_SAFE_EXTS"));
for (const s of ["src/lib/invoice-storage.ts", "src/lib/expense-storage.ts", "src/lib/refund-storage.ts"]) {
  check(`S ${s.split("/").pop()} magic-byte on persist`, /sniffDocumentSignature\(/.test(read(s)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
