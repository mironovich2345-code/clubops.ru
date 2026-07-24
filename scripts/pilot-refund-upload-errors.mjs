// Диагностика загрузки документов возврата: первопричина (Next body limit + bare
// catch), структурные коды ошибок, точные сообщения, HEIC-байты, дубликаты,
// наблюдаемость. Мирроринг сниффера/классификатора + статические гарантии.
// npm run pilot:refund-upload-errors
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ---- mirror: detectSignatureMime incl. HEIC brand (refund-document-storage.ts) ----
function detect(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("latin1").toLowerCase();
    if (["heic", "heix", "heif", "mif1", "hevc", "hevx"].includes(brand)) return "image/heic";
  }
  return null;
}
// ---- mirror: classifyStorageError ----
const classify = (msg) => (/not configured|missing|ENOTFOUND|ECONNREFUSED|AccessDenied|credentials|endpoint/i.test(msg) ? "STORAGE_UNAVAILABLE" : "STORAGE_WRITE_FAILED");

function heicBuf() {
  const b = Buffer.alloc(16, 0);
  b.write("ftyp", 4, "latin1");
  b.write("heic", 8, "latin1");
  return b;
}

function main() {
  // --- signature detection ---
  check("RUP1 JPEG detected", detect(Buffer.from([0xff, 0xd8, 0xff, 0x00])) === "image/jpeg");
  check("RUP2 PDF detected", detect(Buffer.from("%PDF-1.4")) === "application/pdf");
  check("RUP3 HEIC detected by ftyp brand (→ precise error, not FILE_INVALID)", detect(heicBuf()) === "image/heic");
  check("RUP4 unknown bytes → null", detect(Buffer.from([1, 2, 3, 4, 5, 6])) === null);

  // --- storage error classification ---
  check("RUP5 S3 misconfig → STORAGE_UNAVAILABLE", classify("S3 storage is not configured: missing S3_BUCKET") === "STORAGE_UNAVAILABLE");
  check("RUP6 disk write failure → STORAGE_WRITE_FAILED", classify("EACCES: permission denied, open ...") === "STORAGE_WRITE_FAILED");
  check("RUP7 network → STORAGE_UNAVAILABLE", classify("ECONNREFUSED 127.0.0.1:9000") === "STORAGE_UNAVAILABLE");

  // ---- static guards ----
  const next = src("../next.config.mjs");
  const storage = src("../src/lib/refund-document-storage.ts");
  const actions = src("../src/app/(app)/refunds/refund-document-actions.ts");
  const editor = src("../src/app/(app)/refunds/_components/RefundDraftEditor.tsx");

  check("RUP8 ROOT CAUSE fixed: serverActions.bodySizeLimit raised above the 1 MB default",
    next.includes("serverActions") && next.includes("bodySizeLimit") && next.includes('"20mb"'));
  check("RUP9 client no longer swallows all errors as generic «Ошибка загрузки»",
    !editor.includes('setError("Ошибка загрузки.")') && editor.includes("transport error") && editor.includes("console.error"));
  check("RUP10 storage failure split into UNAVAILABLE vs WRITE_FAILED + classifier used",
    actions.includes("classifyStorageError(e)") && storage.includes("STORAGE_UNAVAILABLE") && storage.includes("STORAGE_WRITE_FAILED"));
  check("RUP11 DB failure split: P2002 → SLOT_CONFLICT, else DATABASE_WRITE_FAILED",
    actions.includes('dbError.code === "P2002"') && actions.includes("DATABASE_WRITE_FAILED") && actions.includes("SLOT_CONFLICT"));
  check("RUP12 HEIC byte-detected → HEIC_UNSUPPORTED with an actionable message",
    storage.includes('code: "HEIC_UNSUPPORTED"') && /iPhone|JPG или PDF/.test(storage));
  check("RUP13 duplicate file rejected (same sha256, different slot)",
    actions.includes("DUPLICATE_FILE") && actions.includes("sha256: digest"));
  check("RUP14 observability: structured server log with a reference id (no content)",
    actions.includes("logUploadFailure") && actions.includes('scope: "refund_upload"') && actions.includes("storageProvider") && !actions.includes("buffer.toString"));
  check("RUP15 user error carries a support reference code",
    actions.includes("(код: ${ref})") || actions.includes("код:"));
  check("RUP16 new structured codes present in the message map",
    ["STORAGE_UNAVAILABLE", "STORAGE_WRITE_FAILED", "DATABASE_WRITE_FAILED", "HEIC_UNSUPPORTED", "DUPLICATE_FILE", "REQUEST_TOO_LARGE", "UPLOAD_TIMEOUT", "NETWORK_ERROR", "UNKNOWN_UPLOAD_ERROR"].every((c) => storage.includes(`${c}:`)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
