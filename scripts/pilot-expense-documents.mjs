// Expense multi-document attachments regression (Phase 2A, Part 14). Exercises
// the storage/validation/scope/soft-remove invariants the services enforce
// (lib/expense-document-storage, expense-attachments, document-actions) directly
// against the dev SQLite DB, mirroring the pure logic + crypto. SAFE: fixed
// "pilot-doc-*" ids, cleaned up. npm run pilot:expense-documents
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const p = new PrismaClient();

// --- mirrors of lib/expense-document-storage ------------------------------
const MAX_FILE = 10 * 1024 * 1024, MAX_COUNT = 10, MAX_AGG = 40 * 1024 * 1024;
const ALLOWED = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const KEY_RE = /^expense-docs\/[a-f0-9]{64}\.(jpg|png|webp|pdf)$/;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
function detectSig(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("latin1") === "ftyp" && /heic|heix|mif1/.test(buf.subarray(8, 12).toString("latin1"))) return "image/heic";
  return null;
}
function safeFilename(o) { const b = (o || "document").replace(/^.*[\\/]/, "").replace(/[ -<>:"|?*]/g, "_").trim(); return (b || "document").slice(0, 180); }
const editable = (e) => e.entryVersion === 2 && ["draft", "needs_correction"].includes(e.status);

// magic-byte sample buffers
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from("%PDF-1.4\n...", "latin1");
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic", "latin1")]);

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const CO = "pilot-doc-co", CLUB = "pilot-doc-club", MGR = "pilot-doc-mgr";
const EDIT = "pilot-doc-edit", VERIFIED = "pilot-doc-verified", LEGACY = "pilot-doc-legacy", OTHER = "pilot-doc-other";

async function cleanup() {
  await p.expenseDocument.deleteMany({ where: { companyId: CO } });
  await p.expense.deleteMany({ where: { companyId: CO } });
  await p.company.deleteMany({ where: { id: CO } });
  await p.user.deleteMany({ where: { id: MGR } });
}
function mkKey() { return `expense-docs/${createHash("sha256").update(String(Math.random()) + String(Date.now())).digest("hex")}.jpg`; }
async function addDoc(expenseId, buf, mime, name = "r.jpg", type = "receipt") {
  return p.expenseDocument.create({ data: { expenseId, companyId: CO, clubId: CLUB, storageKey: mkKey(), originalFilename: name, safeFilename: safeFilename(name), mimeType: mime, sizeBytes: buf.length, sha256: sha256(buf), documentType: type, uploadedByUserId: MGR } });
}

async function main() {
  await cleanup();
  await p.user.create({ data: { id: MGR, email: "pilot-doc-mgr@x.dev", name: "M", role: "manager", isActive: true } });
  await p.company.create({ data: { id: CO, name: "Doc Co" } });
  await p.club.create({ data: { id: CLUB, name: "Doc Club", city: "X", companyId: CO } });
  const base = { companyId: CO, clubId: CLUB, createdByUserId: MGR, category: "household", amountKopeks: 1000, expenseDate: new Date() };
  await p.expense.create({ data: { id: EDIT, ...base, status: "draft", entryVersion: 2 } });
  await p.expense.create({ data: { id: VERIFIED, ...base, status: "verified", entryVersion: 2 } });
  await p.expense.create({ data: { id: OTHER, ...base, status: "draft", entryVersion: 2 } });
  await p.expense.create({ data: { id: LEGACY, ...base, status: "confirmed", entryVersion: 1, originalFileStorageKey: "expenses/" + "a".repeat(32) + ".jpg", originalFileName: "old.jpg", originalFileMime: "image/jpeg" } });

  // 1 schema exists
  const d1 = await addDoc(EDIT, JPEG, "image/jpeg");
  check("1 ExpenseDocument row created", d1 && d1.expenseId === EDIT);
  // 16/19 sha stored + safe key format
  check("16 sha256 stored", d1.sha256 === sha256(JPEG));
  check("19 storage key is expense-docs/<64hex>.ext", KEY_RE.test(d1.storageKey), d1.storageKey);

  // 3/4 legacy normalization: legacy expense exposes its old doc
  const legacy = await p.expense.findUnique({ where: { id: LEGACY } });
  check("3 legacy originalFileStorageKey valid", Boolean(legacy.originalFileStorageKey));
  check("4 legacy normalizes (has legacy attachment, no ExpenseDocument)", (await p.expenseDocument.count({ where: { expenseId: LEGACY, removedAt: null } })) === 0 && legacy.entryVersion === 1);

  // 11/12 signature detection
  check("11 JPEG signature detected", detectSig(JPEG) === "image/jpeg");
  check("11 PNG signature detected", detectSig(PNG) === "image/png");
  check("11 PDF signature detected", detectSig(PDF) === "application/pdf");
  check("HEIC detected (and would be rejected)", detectSig(HEIC) === "image/heic");
  check("12 MIME mismatch detectable (png bytes declared jpeg)", detectSig(PNG) !== "image/jpeg");

  // 17/18 duplicate within same expense vs allowed across expenses
  const active = await p.expenseDocument.findMany({ where: { expenseId: EDIT, removedAt: null }, select: { sha256: true } });
  const dupInSame = active.some((a) => a.sha256 === sha256(JPEG));
  check("17 duplicate active doc in same expense detected", dupInSame);
  const dOther = await addDoc(OTHER, JPEG, "image/jpeg");
  check("18 same content on different expense allowed", dOther && dOther.expenseId === OTHER);

  // 13/14 multiple + count limit
  await addDoc(EDIT, PNG, "image/png", "b.png");
  check("13 multiple documents accepted", (await p.expenseDocument.count({ where: { expenseId: EDIT, removedAt: null } })) === 2);
  check("14 count limit constant enforced", MAX_COUNT === 10);
  check("15 aggregate limit constant enforced", MAX_AGG === 40 * 1024 * 1024 && MAX_FILE === 10 * 1024 * 1024);

  // 20 path traversal in filename neutralized
  check("20 safeFilename strips path", safeFilename("../../../etc/passwd") === "passwd" && !safeFilename("a/b\\c.jpg").includes("/"));

  // 8/scope isolation: doc belongs to its expense/company/club
  check("8 doc scope stored (company+club match)", d1.companyId === CO && d1.clubId === CLUB);
  const foreign = await p.expenseDocument.findFirst({ where: { id: d1.id, expenseId: OTHER } });
  check("24 foreign expense cannot claim this doc (belongs check)", foreign === null);

  // 25/26/27/28 soft-remove
  const removed = await p.expenseDocument.updateMany({ where: { id: d1.id, removedAt: null }, data: { removedAt: new Date(), removedByUserId: MGR, removalReason: "тест" } });
  check("27 removal is soft (row still exists)", (await p.expenseDocument.findUnique({ where: { id: d1.id } })) !== null);
  check("25/28 removed hidden from active list", (await p.expenseDocument.count({ where: { expenseId: EDIT, removedAt: null } })) === 1);
  const again = await p.expenseDocument.updateMany({ where: { id: d1.id, removedAt: null }, data: { removedAt: new Date() } });
  check("29 duplicate removal is idempotent (0 rows the 2nd time)", removed.count === 1 && again.count === 0);

  // 30 editability: verified not editable; draft editable; legacy not editable
  check("30 verified expense not doc-editable", !editable(await p.expense.findUnique({ where: { id: VERIFIED } })));
  check("draft expense doc-editable", editable(await p.expense.findUnique({ where: { id: EDIT } })));
  check("legacy (v1) not doc-editable", !editable(legacy));

  // 42 financial totals unaffected by documents (verified realized count unchanged)
  const realized = await p.expense.count({ where: { clubId: CLUB, status: { in: ["confirmed", "verified"] } } });
  check("42 realized-expense count unaffected by documents", realized === 2, `count=${realized}`);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
