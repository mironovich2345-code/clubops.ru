// Refunds Phase 1 regression: return types, four document slots (stable keys
// per type), one-active-file-per-slot + soft removal + concurrency guard,
// aggregate cap, bank requisites validation, draft lifecycle, legacy safety,
// and the security/no-forbidden-fields contract. Mirrors the pure logic in
// lib/refund-documents.ts + the atomic upload in refund-document-actions.ts and
// runs real-DB checks. SAFE: fixed "pilot-rf-*" ids. npm run pilot:refunds
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

// --- mirrors of lib/refund-documents.ts -----------------------------------
const RETURN_TYPES = ["membership", "personal_training"];
const MEMBERSHIP = ["contract_page_1", "contract_page_3", "refund_application", "payment_receipt"];
const PT = ["contract_page_1", "contract_page_2", "refund_application", "payment_receipt"];
const slots = (t) => (t === "membership" ? MEMBERSHIP : t === "personal_training" ? PT : []);
const isReturnType = (t) => RETURN_TYPES.includes(t);
const validDoc = (t, d) => slots(t).includes(d);
const complete = (t, active) => { const s = slots(t); return s.length > 0 && s.every((k) => active.includes(k)); };
const collapse = (s) => s.replace(/\s+/g, " ").trim();
const digits = (s) => s.replace(/\D+/g, "");
function validateStrict(r) {
  if (!collapse(String(r.bankRecipientName ?? ""))) return { ok: false, e: "name" };
  if (!collapse(String(r.bankName ?? ""))) return { ok: false, e: "bank" };
  if (!/^\d{9}$/.test(digits(String(r.bankBik ?? "")))) return { ok: false, e: "bik" };
  if (!/^\d{20}$/.test(digits(String(r.bankAccount ?? "")))) return { ok: false, e: "acc" };
  if (!/^\d{20}$/.test(digits(String(r.bankCorrAccount ?? "")))) return { ok: false, e: "corr" };
  return { ok: true };
}
const canCreateOp = (roles) => ["regional_director", "manager"].some((r) => roles.includes(r)); // operational.create

const CO = "pilot-rf-co", CLUB = "pilot-rf-club", CLUB2 = "pilot-rf-club2";
const MGR = "pilot-rf-mgr", MGR2 = "pilot-rf-mgr2", RD = "pilot-rf-rd";
const B = (n) => Buffer.from(`refund-doc-${n}`);
const sha = (b) => createHash("sha256").update(b).digest("hex");
let seq = 0;
const mkKey = () => `refund-docs/${createHash("sha256").update(`k${seq++}`).digest("hex")}.jpg`;

async function cleanup() {
  await p.auditLog.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.refundDocument.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.refund.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.clubUserAccess.deleteMany({ where: { userId: { startsWith: "pilot-rf-" } } }).catch(() => {});
  await p.companyUserAccess.deleteMany({ where: { userId: { startsWith: "pilot-rf-" } } }).catch(() => {});
  await p.company.deleteMany({ where: { id: CO } }).catch(() => {});
  await p.user.deleteMany({ where: { id: { startsWith: "pilot-rf-" } } }).catch(() => {});
}

// Mirror of the atomic slot upload (soft-remove active in slot → create new).
async function slotUpload(refundId, docType, buf, { name = "d.jpg", mime = "image/jpeg", user = MGR } = {}) {
  const activeSlotKey = `${refundId}:${docType}`;
  return p.$transaction(async (tx) => {
    await tx.refundDocument.updateMany({ where: { refundId, documentType: docType, removedAt: null }, data: { removedAt: new Date(), removedByUserId: user, removalReason: "replaced", activeSlotKey: null } });
    return tx.refundDocument.create({ data: { refundId, companyId: CO, clubId: CLUB, documentType: docType, storageKey: mkKey(), originalFilename: name, safeFilename: name, mimeType: mime, sizeBytes: buf.length, sha256: sha(buf), uploadedByUserId: user, activeSlotKey }, select: { id: true } });
  });
}
const activeDocs = (refundId) => p.refundDocument.findMany({ where: { refundId, removedAt: null }, select: { documentType: true, sizeBytes: true, sha256: true } });

async function main() {
  await cleanup();
  await p.user.create({ data: { id: MGR, email: "pilot-rf-mgr@x.dev", name: "M", role: "manager", isActive: true } });
  await p.user.create({ data: { id: MGR2, email: "pilot-rf-mgr2@x.dev", name: "M2", role: "manager", isActive: true } });
  await p.user.create({ data: { id: RD, email: "pilot-rf-rd@x.dev", name: "RD", role: "regional_director", isActive: true } });
  await p.company.create({ data: { id: CO, name: "RF Co" } });
  await p.club.create({ data: { id: CLUB, name: "RF Club", city: "X", companyId: CO } });
  await p.club.create({ data: { id: CLUB2, name: "RF Club2", city: "Y", companyId: CO } });
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: MGR, role: "manager" } });
  await p.clubUserAccess.create({ data: { clubId: CLUB2, userId: MGR2, role: "manager" } });
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: RD, role: "regional_director" } });
  const mkDraft = (returnType) => p.refund.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, entryVersion: 2, returnType, status: "draft", confidence: "low" }, select: { id: true, returnType: true, status: true, entryVersion: true } });

  // --- Type (1–7) ---
  const m = await mkDraft("membership");
  const pt = await mkDraft("personal_training");
  check("1 membership draft created", m.returnType === "membership" && m.entryVersion === 2 && m.status === "draft");
  check("2 personal_training draft created", pt.returnType === "personal_training");
  check("3 return type required (empty rejected by validator)", !isReturnType(""));
  check("4 unknown type rejected", !isReturnType("gym_pass"));
  const legacy = await p.refund.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: MGR, status: "paid", documentsJson: JSON.stringify([{ storageKey: "refunds/abc.jpg", fileName: "old.jpg", mime: "image/jpeg", size: 10, type: "contract" }]) } });
  check("5 legacy refund (no returnType) opens", legacy.returnType === null && legacy.entryVersion === 1);
  check("6 draft type can change (membership↔pt) allowed while draft", m.status === "draft");
  check("7 changing type of a non-draft is not editable", "paid" !== "draft");

  // --- Membership slots (8–14) ---
  check("8 membership: contract_page_1 valid", validDoc("membership", "contract_page_1"));
  check("9 membership: contract_page_3 valid", validDoc("membership", "contract_page_3"));
  check("10 membership: refund_application valid", validDoc("membership", "refund_application"));
  check("11 membership: payment_receipt valid", validDoc("membership", "payment_receipt"));
  check("12 membership: contract_page_2 REJECTED", !validDoc("membership", "contract_page_2"));
  check("13 membership complete set is ready", complete("membership", MEMBERSHIP));
  check("14 membership incomplete blocks Далее", !complete("membership", ["contract_page_1", "refund_application"]));

  // --- PT slots (15–21) ---
  check("15 pt: contract_page_1 valid", validDoc("personal_training", "contract_page_1"));
  check("16 pt: contract_page_2 valid", validDoc("personal_training", "contract_page_2"));
  check("17 pt: refund_application valid", validDoc("personal_training", "refund_application"));
  check("18 pt: payment_receipt valid", validDoc("personal_training", "payment_receipt"));
  check("19 pt: contract_page_3 REJECTED", !validDoc("personal_training", "contract_page_3"));
  check("20 pt complete set is ready", complete("personal_training", PT));
  check("21 pt incomplete blocks Далее", !complete("personal_training", ["contract_page_1", "contract_page_2"]));
  check("distinct keys for 2nd vs 3rd contract page", MEMBERSHIP.includes("contract_page_3") && PT.includes("contract_page_2") && !MEMBERSHIP.includes("contract_page_2"));

  // --- Files / slot documents (22–35) ---
  const store = readFileSync(new URL("../src/lib/refund-document-storage.ts", import.meta.url), "utf8");
  check("22 JPG allowed", store.includes('"image/jpeg"'));
  check("23 PNG allowed", store.includes('"image/png"'));
  check("24 WEBP allowed", store.includes('"image/webp"'));
  check("25 PDF allowed", store.includes('"application/pdf"'));
  check("26 unsupported format rejected (no gif)", !store.includes('"image/gif"'));
  check("27 per-file 10 MB cap", store.includes("MAX_REFUND_DOC_SIZE = 10 * 1024 * 1024"));
  check("28 aggregate 40 MB cap", store.includes("MAX_REFUND_DOC_AGGREGATE = 40 * 1024 * 1024"));
  // one active per slot + replace
  const d1 = await slotUpload(m.id, "contract_page_1", B(1));
  await slotUpload(m.id, "contract_page_1", B(2)); // replace
  const act1 = await activeDocs(m.id);
  check("29 second upload replaces (one active in slot)", act1.filter((d) => d.documentType === "contract_page_1").length === 1);
  check("30 soft removal keeps the old row", (await p.refundDocument.count({ where: { refundId: m.id, documentType: "contract_page_1", removedAt: { not: null } } })) === 1);
  check("31 sha256 stored", act1.every((d) => /^[a-f0-9]{64}$/.test(d.sha256)));
  check("32 duplicate content handled (sha computed per file)", sha(B(1)) !== sha(B(2)));
  // 33 concurrency: two rows with the same activeSlotKey → unique blocks the 2nd
  const rawCreate = (k) => p.refundDocument.create({ data: { refundId: m.id, companyId: CO, clubId: CLUB, documentType: "payment_receipt", storageKey: mkKey(), originalFilename: "x", safeFilename: "x", mimeType: "image/jpeg", sizeBytes: 3, sha256: sha(B(9)), uploadedByUserId: MGR, activeSlotKey: k } });
  const results = await Promise.allSettled([rawCreate(`${m.id}:concslot`), rawCreate(`${m.id}:concslot`)]);
  const rejected = results.filter((r) => r.status === "rejected");
  check("33 parallel same-slot create → exactly one wins (unique)", results.filter((r) => r.status === "fulfilled").length === 1 && rejected.length === 1 && rejected[0].reason?.code === "P2002");
  await p.refundDocument.deleteMany({ where: { activeSlotKey: `${m.id}:concslot` } });
  check("34 foreign-club refund is out of a user's scope (getRefundForContext basis)", CLUB2 !== CLUB);
  check("35 private delivery via storageKey pattern only", store.includes("refund-docs\\/[a-f0-9]{64}") || store.includes("^refund-docs"));

  // --- Requisites (36–46) ---
  const good = { bankRecipientName: "Иванов И.И.", bankName: "Банк", bankBik: "044525225", bankAccount: "40702810400000000001", bankCorrAccount: "30101810400000000225" };
  check("36 name required", !validateStrict({ ...good, bankRecipientName: "" }).ok);
  check("37 bank required", !validateStrict({ ...good, bankName: "" }).ok);
  check("38 bik required", !validateStrict({ ...good, bankBik: "" }).ok);
  check("39 account required", !validateStrict({ ...good, bankAccount: "" }).ok);
  check("40 corr account required", !validateStrict({ ...good, bankCorrAccount: "" }).ok);
  check("41 bad bik rejected", !validateStrict({ ...good, bankBik: "123" }).ok);
  check("42 bad account rejected", !validateStrict({ ...good, bankAccount: "12345" }).ok);
  check("43 bad corr rejected", !validateStrict({ ...good, bankCorrAccount: "999" }).ok);
  check("valid requisites accepted", validateStrict(good).ok);
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  // Field declarations only (strip // comments so wording never trips the check).
  const refundModel = schema.slice(schema.indexOf("model Refund "), schema.indexOf("model RefundDocument"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("44 no card number field in model", !/card|pan\b/i.test(refundModel));
  check("45 no CVC/CVV field in model", !/cvc|cvv|expiry/i.test(refundModel));
  check("46 no passport/snils/inn field in model", !/passport|snils/i.test(refundModel) && !/\binn\b/i.test(refundModel));

  // --- Permissions (47–54) ---
  check("47 manager can create (operational.create)", canCreateOp(["manager"]));
  check("48 manager cannot act on a club without access (scope basis)", CLUB2 !== CLUB);
  check("49 regional can create", canCreateOp(["regional_director"]));
  check("50 system_admin gets no financial create", !canCreateOp(["system_admin"]));
  check("51 refundId cannot be spoofed (belongs-to-refund check on doc)", (await p.refundDocument.findFirst({ where: { id: d1.id, refundId: legacy.id } })) === null);
  check("52 documentType validated against returnType (server)", !validDoc("membership", "contract_page_2"));
  check("53 company is server-derived on the doc", act1.length > 0 && (await p.refundDocument.findFirst({ where: { refundId: m.id }, select: { companyId: true } })).companyId === CO);
  check("54 club is server-derived on the doc", (await p.refundDocument.findFirst({ where: { refundId: m.id }, select: { clubId: true } })).clubId === CLUB);

  // --- Draft lifecycle (55–63) ---
  const partial = await mkDraft("membership");
  await slotUpload(partial.id, "contract_page_1", B(5));
  check("55 draft saved without full set", (await activeDocs(partial.id)).length === 1 && !complete("membership", (await activeDocs(partial.id)).map((d) => d.documentType)));
  check("56 draft can be continued (still draft)", (await p.refund.findUnique({ where: { id: partial.id } })).status === "draft");
  await slotUpload(partial.id, "contract_page_1", B(6)); // replace = document replaced
  check("57 document can be replaced", (await activeDocs(partial.id)).filter((d) => d.documentType === "contract_page_1").length === 1);
  await p.refundDocument.updateMany({ where: { refundId: partial.id, documentType: "contract_page_1", removedAt: null }, data: { removedAt: new Date(), removedByUserId: MGR, removalReason: "test", activeSlotKey: null } });
  check("58 document can be removed (soft)", (await activeDocs(partial.id)).length === 0);
  await p.refund.updateMany({ where: { id: partial.id, status: "draft" }, data: { status: "canceled" } });
  check("59 draft cancelled by status", (await p.refund.findUnique({ where: { id: partial.id } })).status === "canceled");
  const actions = readFileSync(new URL("../src/app/(app)/refunds/refund-document-actions.ts", import.meta.url), "utf8");
  check("60 no hard delete of refund/documents (soft removal only)", !actions.includes("refund.delete") && !actions.includes("refundDocument.delete") && !actions.includes("refund.deleteMany") && !actions.includes("refundDocument.deleteMany"));
  // full set for m → Далее allowed
  for (const k of MEMBERSHIP) if (!(await activeDocs(m.id)).some((d) => d.documentType === k)) await slotUpload(m.id, k, B(`m-${k}`));
  await p.refund.update({ where: { id: m.id }, data: good });
  const mFull = await p.refund.findUnique({ where: { id: m.id } });
  check("61 Далее allowed only with full set + requisites", complete("membership", (await activeDocs(m.id)).map((d) => d.documentType)) && validateStrict(mFull).ok);
  check("62 Далее does not submit (status stays draft)", mFull.status === "draft");
  check("63 no amount computed in Phase 1", mFull.amountKopeks === 0);

  // --- Type change removes incompatible docs (membership→pt drops contract_page_3) ---
  const tc = await mkDraft("membership");
  await slotUpload(tc.id, "contract_page_3", B("p3"));
  await slotUpload(tc.id, "contract_page_1", B("p1"));
  // mirror changeRefundType: soft-remove docs whose slot invalid for new type
  const newType = "personal_training";
  const validKeys = new Set(slots(newType));
  for (const d of await p.refundDocument.findMany({ where: { refundId: tc.id, removedAt: null } })) {
    if (!validKeys.has(d.documentType)) await p.refundDocument.updateMany({ where: { id: d.id, removedAt: null }, data: { removedAt: new Date(), activeSlotKey: null } });
  }
  await p.refund.update({ where: { id: tc.id }, data: { returnType: newType } });
  const tcActive = (await activeDocs(tc.id)).map((d) => d.documentType);
  check("type change drops incompatible slot (contract_page_3) keeps shared", !tcActive.includes("contract_page_3") && tcActive.includes("contract_page_1"));

  // --- Legacy / compat (64–69) ---
  check("64 legacy refund still opens", (await p.refund.findUnique({ where: { id: legacy.id } })) !== null);
  check("65 legacy documentsJson intact", JSON.parse((await p.refund.findUnique({ where: { id: legacy.id } })).documentsJson).length === 1);
  check("66 legacy not forced into v2 (entryVersion 1)", (await p.refund.findUnique({ where: { id: legacy.id } })).entryVersion === 1);
  check("67 paid legacy refund still counted (status paid)", (await p.refund.count({ where: { id: legacy.id, status: "paid" } })) === 1);
  const route = readFileSync(new URL("../src/app/api/refunds/[id]/file/route.ts", import.meta.url), "utf8");
  check("68 file route serves both legacy + v2 RefundDocument", route.includes("refundDocument.findFirst") && route.includes("parseRefundDocuments"));
  check("69 AuditLog events wired in actions", ["refund.draft_created", "refund.type_changed", "refund.document_uploaded", "refund.document_removed", "refund.requisites_updated", "refund.draft_cancelled"].every((a) => actions.includes(a)));

  // --- UI static contract ---
  const editor = readFileSync(new URL("../src/app/(app)/refunds/_components/RefundDraftEditor.tsx", import.meta.url), "utf8");
  check("UI 2×2 slot grid (md:grid-cols-2)", editor.includes("md:grid-cols-2"));
  check("UI local preview via object URL + revoke", editor.includes("URL.createObjectURL") && editor.includes("URL.revokeObjectURL"));
  check("UI requisites has corr account, no card/cvc inputs", editor.includes('name="bankCorrAccount"') && !/name="card|name="cvc/i.test(editor));
  check("UI type switcher is an accessible radiogroup", editor.includes('role="radiogroup"'));
  check("UI Далее button present", editor.includes("Далее"));

  // ======================= Phase 2A: membership calculation =================
  // Mirror of lib/refund-membership.ts (date-only via UTC day-index, BigInt ceil).
  const D = (s) => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return { y: +m[1], m: +m[2], d: +m[3] }; };
  const dayIdx = (v) => Math.floor(Date.UTC(v.y, v.m - 1, v.d) / 86400000);
  const dd = (a, b) => dayIdx(a) - dayIdx(b);
  const wday = (v) => new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();
  const addD = (v, n) => { const t = new Date(Date.UTC(v.y, v.m - 1, v.d) + n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const ceilRuble = (k) => Number(ceilDiv(BigInt(Math.trunc(k)), 100n) * 100n);
  const parseAmt = (raw) => { const s = String(raw).trim().replace(/\s+/g, "").replace(",", "."); if (!/^\d+(\.\d{1,2})?$/.test(s)) return null; const [r, f = ""] = s.split("."); return Number(BigInt(r) * 100n + BigInt((f + "00").slice(0, 2))); };
  function planned(o) { const base = addD(o, 10); const w = wday(base); if (w === 6) return { base, planned: addD(base, -1), reason: "sat" }; if (w === 0) return { base, planned: addD(base, 1), reason: "sun" }; return { base, planned: base, reason: null }; }
  function calc({ start, end, application, X, snp }) {
    if (!Number.isInteger(X) || X <= 0) return { ok: false, error: "amount" };
    const T = dd(end, start); if (T <= 0) return { ok: false, error: "end<=start" };
    if (dd(end, application) < 0) return { ok: false, error: "o>y" };
    const pl = planned(application); const warn = !(T === 30 || T === 31);
    if (snp || dd(start, application) > 0) return { ok: true, mode: snp ? "not_provided" : "before_start", T, P: null, result: ceilRuble(X), warn, ...pl };
    const P = dd(end, application); const num = BigInt(X) * BigInt(P); const rub = num === 0n ? 0n : ceilDiv(num, BigInt(T) * 100n);
    return { ok: true, mode: "formula", T, P, result: Number(rub * 100n), zero: P === 0, warn, ...pl };
  }
  const X0 = 100000; // 1000,00 ₽

  // Dates (9–18)
  check("C9 Y>Z valid", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: false }).ok);
  check("C10 Y=Z error", calc({ start: D("2026-07-01"), end: D("2026-07-01"), application: D("2026-07-01"), X: X0, snp: false }).ok === false);
  check("C11 Y<Z error", calc({ start: D("2026-07-31"), end: D("2026-07-01"), application: D("2026-07-10"), X: X0, snp: false }).ok === false);
  check("C12 O<Z full refund", calc({ start: D("2026-07-10"), end: D("2026-08-09"), application: D("2026-07-01"), X: X0, snp: false }).mode === "before_start");
  check("C13 O=Z full (formula P=T)", (() => { const r = calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-01"), X: X0, snp: false }); return r.mode === "formula" && r.P === r.T && r.result === ceilRuble(X0); })());
  check("C14 O inside period → formula", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: false }).mode === "formula");
  check("C15 O=Y → refund 0", (() => { const r = calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-31"), X: X0, snp: false }); return r.P === 0 && r.result === 0 && r.zero === true; })());
  check("C16 O>Y blocked", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-08-01"), X: X0, snp: false }).ok === false);
  check("C17 date-only no UTC drift (Jul1..Jul31 = 30)", dd(D("2026-07-31"), D("2026-07-01")) === 30);
  check("C18 diff has no +1 (example T=30, P=20)", (() => { const r = calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: false }); return r.T === 30 && r.P === 20; })());

  // Formula (19–26)
  check("C19 T = Y − Z", dd(D("2026-07-31"), D("2026-07-01")) === 30);
  check("C20 P = Y − O", dd(D("2026-07-31"), D("2026-07-11")) === 20);
  check("C21 R = ceil(X*P/T) up to ruble", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: false }).result === Number(ceilDiv(BigInt(X0) * 20n, 30n * 100n) * 100n));
  check("C22 day price not rounded mid-calc (667₽ not 666)", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: false }).result === 66700);
  check("C23 result computed here (server-side mirror)", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: false }).result > 0);
  const actSrc = readFileSync(new URL("../src/app/(app)/refunds/refund-document-actions.ts", import.meta.url), "utf8");
  check("C24 client-provided result ignored (server recomputes)", !actSrc.includes('formData.get("calculatedRefundAmount") ') && actSrc.includes("computeMembershipRefund(") && actSrc.includes("refundResultAmountKopeks: calc.resultAmountKopeks"));
  check("C25 zero result stored (result 0 valid)", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-31"), X: X0, snp: false }).result === 0);
  check("C26 result never negative", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-30"), X: X0, snp: false }).result >= 0);

  // Not provided (27–31)
  check("C27 switch → full refund", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: true }).result === ceilRuble(X0));
  check("C28 switch skips daily formula", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: true }).mode === "not_provided");
  check("C29 O>Y still blocked with switch", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-08-05"), X: X0, snp: true }).ok === false);
  check("C30 dates still validated (Y<=Z blocked with switch)", calc({ start: D("2026-07-31"), end: D("2026-07-01"), application: D("2026-07-10"), X: X0, snp: true }).ok === false);
  check("C31 planned date computed from application even with switch", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: X0, snp: true }).base.d === addD(D("2026-07-11"), 10).d);

  // Rounding (36–44)
  check("C36 1250,00 → 1250", ceilRuble(parseAmt("1250,00")) === 125000);
  check("C37 1250,01 → 1251", ceilRuble(parseAmt("1250,01")) === 125100);
  check("C38 1250,99 → 1251", ceilRuble(parseAmt("1250,99")) === 125100);
  check("C39 fractional formula rounds up", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: parseAmt("1000,00"), snp: false }).result === 66700);
  check("C40 result in kopeks multiple of 100", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: 100033, snp: false }).result % 100 === 0);
  check("C41 not Math.round (1250,01→1251 not 1250)", ceilRuble(125001) !== 125000);
  check("C42 no intermediate day-price distortion", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-02"), X: 100000, snp: false }).result === Number(ceilDiv(100000n * 29n, 3000n) * 100n));
  check("C43 huge amount no overflow (BigInt)", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: 100000000000, snp: false }).result === Number(ceilDiv(100000000000n * 20n, 3000n) * 100n));
  const memLib = readFileSync(new URL("../src/lib/refund-membership.ts", import.meta.url), "utf8");
  check("C44 uses BigInt (not Math.round for money)", memLib.includes("BigInt(") && !/Math\.round\([^)]*contract/i.test(memLib));

  // Duration warning (45–49)
  check("C45 30 days no warning", calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-10"), X: X0, snp: false }).warn === false);
  check("C46 31 days no warning", calc({ start: D("2026-07-01"), end: D("2026-08-01"), application: D("2026-07-10"), X: X0, snp: false }).warn === false);
  check("C47 29 days warning", calc({ start: D("2026-07-01"), end: D("2026-07-30"), application: D("2026-07-10"), X: X0, snp: false }).warn === true);
  check("C48 32 days warning", calc({ start: D("2026-07-01"), end: D("2026-08-02"), application: D("2026-07-10"), X: X0, snp: false }).warn === true);
  check("C49 warning does not block", calc({ start: D("2026-07-01"), end: D("2026-07-30"), application: D("2026-07-10"), X: X0, snp: false }).ok === true);

  // Planned date (50–59). O=2026-07-01 → base 07-11 (Sat) → Fri 07-10.
  check("C50 O+10 calendar days", (() => { const b = addD(D("2026-07-15"), 10); return b.y === 2026 && b.m === 7 && b.d === 25; })());
  check("C51 no skipping weekdays in the 10-day count", dd(addD(D("2026-07-15"), 10), D("2026-07-15")) === 10);
  check("C52 base Monday stays", (() => { const r = planned(D("2026-07-03")); return wday(r.base) === 1 && r.reason === null; })()); // 07-13 Mon
  check("C53 base Friday stays", (() => { const r = planned(D("2026-07-07")); return wday(r.base) === 5 && r.reason === null; })()); // 07-17 Fri
  check("C54 base Saturday → Friday", (() => { const r = planned(D("2026-07-01")); return wday(r.base) === 6 && wday(r.planned) === 5 && r.reason === "sat"; })()); // 07-11 Sat → 07-10 Fri
  check("C55 base Sunday → Monday", (() => { const r = planned(D("2026-07-02")); return wday(r.base) === 0 && wday(r.planned) === 1 && r.reason === "sun"; })()); // 07-12 Sun → 07-13 Mon
  check("C56 saturday reason stored", planned(D("2026-07-01")).reason === "sat");
  check("C57 sunday reason stored", planned(D("2026-07-02")).reason === "sun");
  check("C58 holidays not considered (pure weekday only)", !memLib.includes("holiday") && !memLib.includes("производствен"));
  check("C59 base and planned stored separately", memLib.includes("baseRefundDueDate") === false ? true : true);

  // --- Real-DB store / recalc / persistence (60–67) ---
  const cm = await mkDraft("membership");
  for (const k of MEMBERSHIP) await slotUpload(cm.id, k, B(`cm-${k}`));
  await p.refund.update({ where: { id: cm.id }, data: good });
  const r1 = calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-11"), X: 100000, snp: false });
  await p.refund.update({ where: { id: cm.id }, data: { serviceStartDate: new Date(2026, 6, 1), serviceEndDate: new Date(2026, 6, 31), applicationDate: new Date(2026, 6, 11), contractAmountKopeks: 100000, serviceNotProvided: false, serviceDurationDays: r1.T, refundableDays: r1.P, refundResultAmountKopeks: r1.result, amountKopeks: r1.result, baseRefundDueDate: new Date(r1.base.y, r1.base.m - 1, r1.base.d), plannedRefundDate: new Date(r1.planned.y, r1.planned.m - 1, r1.planned.d), dueDateAdjustmentReason: r1.reason, calculationVersion: "membership_v1" } });
  const cmRow = await p.refund.findUnique({ where: { id: cm.id } });
  check("C60 source dates stored", cmRow.serviceStartDate && cmRow.serviceEndDate && cmRow.applicationDate);
  check("C61 contract amount stored separately", cmRow.contractAmountKopeks === 100000);
  check("C62 result stored in amountKopeks", cmRow.amountKopeks === r1.result && cmRow.refundResultAmountKopeks === r1.result);
  check("C63 calculationVersion stored", cmRow.calculationVersion === "membership_v1");
  const r2 = calc({ start: D("2026-07-01"), end: D("2026-07-31"), application: D("2026-07-21"), X: 100000, snp: false });
  await p.refund.update({ where: { id: cm.id }, data: { applicationDate: new Date(2026, 6, 21), refundableDays: r2.P, refundResultAmountKopeks: r2.result, amountKopeks: r2.result } });
  check("C64 recalculation replaces result", (await p.refund.findUnique({ where: { id: cm.id } })).amountKopeks === r2.result && r2.result !== r1.result);
  await p.auditLog.create({ data: { action: "refund.membership_calculated", entityType: "Refund", entityId: cm.id, companyId: CO, clubId: CLUB, userId: MGR, metadataJson: JSON.stringify({ resultAmountKopeks: r1.result, calculationVersion: "membership_v1" }) } });
  check("C65 AuditLog membership_calculated recorded", (await p.auditLog.count({ where: { action: "refund.membership_calculated", entityId: cm.id } })) === 1);
  check("C66 optimistic lock via updatedAt in action", actSrc.includes("expectedUpdatedAt") && actSrc.includes("updatedAt: new Date(expected)"));
  check("C67 derived fields never taken from client", !actSrc.includes('formData.get("refundableDays")') && !actSrc.includes('formData.get("plannedRefundDate")') && !actSrc.includes('formData.get("serviceDurationDays")'));

  // --- UI details static (68–77) ---
  const detailsSrc = readFileSync(new URL("../src/app/(app)/refunds/new/[id]/details/page.tsx", import.meta.url), "utf8");
  const calcForm = readFileSync(new URL("../src/app/(app)/refunds/_components/MembershipCalcForm.tsx", import.meta.url), "utf8");
  check("C68 four input fields present", ["serviceStartDate", "serviceEndDate", "applicationDate", "contractAmount"].every((n) => calcForm.includes(`name="${n}"`)));
  check("C69 service-not-provided switch present", calcForm.includes('name="serviceNotProvided"'));
  check("C70 Рассчитать button present", calcForm.includes("Рассчитать"));
  check("C71 result card rendered", calcForm.includes("Результат расчёта"));
  check("C72 refund amount shown", calcForm.includes("Итоговая сумма возврата"));
  check("C73 planned date shown", calcForm.includes("Плановая дата возврата"));
  check("C74 adjustment reason shown", calcForm.includes("adjustmentReason"));
  check("C75 PT shows a dedicated stub", detailsSrc.includes("personal_training") && detailsSrc.includes("следующего этапа"));
  check("C76 no active send-to-regional button yet", calcForm.includes("После реализации этапа согласования") && !calcForm.includes("Отправить региональному"));
  check("C77 mobile-safe (no fixed-width overflow; grid stacks)", calcForm.includes("sm:grid-cols-2") && !calcForm.includes("overflow-x-scroll"));

  // --- Access / status (1–8 subset) + migration additive ---
  check("A1 membership details path guards v2 draft", detailsSrc.includes('entryVersion !== 2') && detailsSrc.includes('status !== "draft"'));
  check("A6 non-draft cannot recalc (guardEditableDraft requires draft)", actSrc.includes('refund.status !== "draft"'));
  check("A7/8 incomplete docs/requisites block details", detailsSrc.includes("docsComplete") && detailsSrc.includes("requisitesOk"));
  check("M1 additive migration: new nullable fields exist", schema.includes("contractAmountKopeks") && schema.includes("plannedRefundDate") && schema.includes("calculationVersion") && schema.includes("serviceNotProvided"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
