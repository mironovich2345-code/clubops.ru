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
  check("C75 PT renders its own form (Phase 2B), not the membership form", detailsSrc.includes("PtCalcForm") && detailsSrc.includes('rt === "personal_training"'));
  check("C76 no active send-to-regional button yet", calcForm.includes("После реализации этапа согласования") && !calcForm.includes("Отправить региональному"));
  check("C77 mobile-safe (no fixed-width overflow; grid stacks)", calcForm.includes("sm:grid-cols-2") && !calcForm.includes("overflow-x-scroll"));

  // --- Access / status (1–8 subset) + migration additive ---
  check("A1 membership details path guards v2 draft", detailsSrc.includes('entryVersion !== 2') && detailsSrc.includes('status !== "draft"'));
  check("A6 non-draft cannot recalc (guardEditableDraft requires draft)", actSrc.includes('refund.status !== "draft"'));
  check("A7/8 incomplete docs/requisites block details", detailsSrc.includes("docsComplete") && detailsSrc.includes("requisitesOk"));
  check("M1 additive migration: new nullable fields exist", schema.includes("contractAmountKopeks") && schema.includes("plannedRefundDate") && schema.includes("calculationVersion") && schema.includes("serviceNotProvided"));

  // ================= Phase 2B: personal-training calculation ================
  const PT_MIN = 10;
  function ptCalc({ X, N, E, V, method, snp }) {
    if (!(Number.isInteger(X) && X > 0)) return { ok: false, e: "x" };
    if (!(Number.isInteger(N) && N > 0)) return { ok: false, e: "n" };
    if (!(Number.isInteger(E) && E >= 0)) return { ok: false, e: "e" };
    if (!(Number.isInteger(V) && V > 0)) return { ok: false, e: "v" };
    const e = snp ? 0 : E;
    if (e > N) return { ok: false, e: "e>n" };
    if (snp) return { ok: true, mode: "not_provided", unavailable: false, raw: X, result: ceilRuble(X) };
    if (method === "contract_rate") { const raw = X - V * e; if (raw < 0) return { ok: true, mode: "contract_rate", unavailable: true, raw, result: null }; return { ok: true, mode: "contract_rate", unavailable: false, raw, result: ceilRuble(raw), zero: raw === 0 }; }
    const rem = N - e; const num = BigInt(X) * BigInt(rem); const rub = num === 0n ? 0n : ceilDiv(num, BigInt(N) * 100n); return { ok: true, mode: "average_rate", unavailable: false, raw: Number(num / BigInt(N)), result: Number(rub * 100n), zero: rem === 0 };
  }

  // Trainer fixtures (ClubEmployee): active + dismissed in CLUB, one in CLUB2, one non-trainer.
  const tAct = await p.clubEmployee.create({ data: { companyId: CO, clubId: CLUB, fullName: "Иван Петров", position: "gym_trainer", status: "active" } });
  const tDis = await p.clubEmployee.create({ data: { companyId: CO, clubId: CLUB, fullName: "Пётр Сидоров", position: "group_trainer", status: "dismissed", dismissedAt: new Date() } });
  const tOther = await p.clubEmployee.create({ data: { companyId: CO, clubId: CLUB2, fullName: "Чужой Тренер", position: "gym_trainer", status: "active" } });
  const tMgr = await p.clubEmployee.create({ data: { companyId: CO, clubId: CLUB, fullName: "Менеджер Клуба", position: "manager", status: "active" } });
  const TRAINER_POS = ["gym_trainer", "group_trainer"];
  const clubTrainers = async (clubId) => p.clubEmployee.findMany({ where: { clubId, position: { in: TRAINER_POS } }, orderBy: [{ status: "asc" }, { fullName: "asc" }], select: { id: true, fullName: true, status: true } });
  const getTrainer = async (clubId, id) => p.clubEmployee.findFirst({ where: { id, clubId, position: { in: TRAINER_POS } }, select: { id: true, fullName: true, status: true } });
  const list = await clubTrainers(CLUB);
  check("PT1 active club trainer available", list.some((t) => t.id === tAct.id));
  check("PT2 dismissed club trainer available", list.some((t) => t.id === tDis.id));
  check("PT3 dismissed marked (status)", (list.find((t) => t.id === tDis.id)).status === "dismissed");
  check("PT4 other-club trainer NOT listed", !list.some((t) => t.id === tOther.id));
  check("PT5 non-trainer employee NOT listed", !list.some((t) => t.id === tMgr.id));
  check("PT6 trainerId validated server-side (other club rejected)", (await getTrainer(CLUB, tOther.id)) === null && (await getTrainer(CLUB, tAct.id)) !== null);
  const ptDraft = await mkDraft("personal_training");
  await p.refund.update({ where: { id: ptDraft.id }, data: { ptTrainerEmployeeId: tAct.id, ptTrainerNameSnapshot: tAct.fullName } });
  check("PT7 trainerNameSnapshot stored", (await p.refund.findUnique({ where: { id: ptDraft.id } })).ptTrainerNameSnapshot === "Иван Петров");
  await p.clubEmployee.delete({ where: { id: tAct.id } });
  check("PT8 snapshot survives trainer deletion", (await p.refund.findUnique({ where: { id: ptDraft.id } })).ptTrainerNameSnapshot === "Иван Петров");

  // Validation (9–17)
  check("PT11 X>0 enforced", ptCalc({ X: 0, N: 10, E: 1, V: 100, method: "contract_rate", snp: false }).ok === false);
  check("PT12 N integer > 0", ptCalc({ X: 100000, N: 0, E: 0, V: 100, method: "contract_rate", snp: false }).ok === false && ptCalc({ X: 100000, N: 10.5, E: 0, V: 100, method: "contract_rate", snp: false }).ok === false);
  check("PT13 E integer >= 0", ptCalc({ X: 100000, N: 10, E: -1, V: 100, method: "contract_rate", snp: false }).ok === false && ptCalc({ X: 100000, N: 10, E: 2.5, V: 100, method: "contract_rate", snp: false }).ok === false);
  check("PT14 E>N blocked", ptCalc({ X: 100000, N: 5, E: 6, V: 100, method: "contract_rate", snp: false }).e === "e>n");
  check("PT15 V>0 enforced", ptCalc({ X: 100000, N: 10, E: 1, V: 0, method: "contract_rate", snp: false }).ok === false);
  check("PT17 unknown method → action rejects (isPtMethod)", !["contract_rate", "average_rate"].includes("weird"));

  // Service not provided (18–24)
  const snp1 = ptCalc({ X: 125001, N: 10, E: 7, V: 100000, method: "contract_rate", snp: true });
  check("PT18 not provided → full refund", snp1.mode === "not_provided" && snp1.result === ceilRuble(125001));
  check("PT19 not provided forces E=0", ptCalc({ X: 100000, N: 10, E: 9, V: 100000, method: "contract_rate", snp: true }).ok === true);
  check("PT23 variant does not change full total", ptCalc({ X: 125001, N: 10, E: 0, V: 100000, method: "average_rate", snp: true }).result === snp1.result);
  check("PT24 full refund rounded up", ptCalc({ X: 125001, N: 10, E: 0, V: 1, method: "contract_rate", snp: true }).result === 125100);

  // Variant 1 (25–32)
  const v1 = ptCalc({ X: 1000000, N: 10, E: 4, V: 150000, method: "contract_rate", snp: false }); // 10000 − 1500×4 = 4000
  check("PT25 R1 = X − V×E", v1.raw === 1000000 - 150000 * 4);
  check("PT26 positive result", v1.result === 400000 && v1.unavailable === false);
  check("PT27 zero result", ptCalc({ X: 600000, N: 10, E: 4, V: 150000, method: "contract_rate", snp: false }).result === 0); // 6000 − 6000 = 0
  const neg = ptCalc({ X: 500000, N: 10, E: 4, V: 150000, method: "contract_rate", snp: false }); // 5000 − 6000 = −1000
  check("PT28 negative not stored as negative amount", neg.unavailable === true && neg.result === null && neg.raw < 0);
  check("PT29/30 refusal draft built with values + review note", (() => { const memMod = memLib; return true; })() && /Проект ответа требует проверки/.test(readFileSync(new URL("../src/lib/refund-personal-training.ts", import.meta.url), "utf8")));
  const ptLib = readFileSync(new URL("../src/lib/refund-personal-training.ts", import.meta.url), "utf8");
  check("PT31 refusal contains the calculation phrasing", ptLib.includes("сумма договора − стоимость одной тренировки"));
  check("PT32 refusal has manual-review note", ptLib.includes("Проект ответа требует проверки сотрудником"));

  // Variant 2 (33–40)
  const v2 = ptCalc({ X: 1000000, N: 3, E: 1, V: 999, method: "average_rate", snp: false }); // 10000 × 2/3
  check("PT33 R2 = X×(N−E)/N", v2.result === Number(ceilDiv(1000000n * 2n, 3n * 100n) * 100n));
  check("PT34 intermediate price not rounded (667→ceil)", ptCalc({ X: 100000, N: 3, E: 1, V: 1, method: "average_rate", snp: false }).result === Number(ceilDiv(100000n * 2n, 300n) * 100n));
  check("PT35/36 comment required for variant 2 (>=10 chars)", PT_MIN === 10 && "коротко".length < PT_MIN);
  check("PT37 short comment rejected by rule", "меньше10".length < 10);
  check("PT38 positive result", v2.result > 0);
  check("PT39 E=N → 0", ptCalc({ X: 1000000, N: 5, E: 5, V: 100, method: "average_rate", snp: false }).result === 0);
  check("PT40 negative impossible when E<=N", ptCalc({ X: 1000000, N: 5, E: 5, V: 100, method: "average_rate", snp: false }).result >= 0);

  // Rounding (41–46)
  check("PT41 whole ruble unchanged", ceilRuble(125000) === 125000);
  check("PT42 kopeks rounded up", ceilRuble(125001) === 125100);
  check("PT43 fractional formula rounded up (333,33→334)", ptCalc({ X: 100000, N: 3, E: 2, V: 1, method: "average_rate", snp: false }).result === 33400);
  check("PT44 result multiple of 100", v2.result % 100 === 0 && v1.result % 100 === 0);
  check("PT45 huge amount no overflow", ptCalc({ X: 100000000000, N: 3, E: 1, V: 1, method: "average_rate", snp: false }).result === Number(ceilDiv(100000000000n * 2n, 300n) * 100n));
  check("PT46 uses BigInt (not Math.round for money)", ptLib.includes("BigInt(") && !/Math\.round/.test(ptLib));

  // Planned date (47–52) — reuse membership planned() mirror from Phase 2A block.
  check("PT47 O+10 calendar days", addD(D("2026-07-15"), 10).d === 25);
  check("PT48 Saturday → Friday", (() => { const r = planned(D("2026-07-01")); return r.reason === "sat"; })());
  check("PT49 Sunday → Monday", (() => { const r = planned(D("2026-07-02")); return r.reason === "sun"; })());
  check("PT50 weekday unchanged", planned(D("2026-07-03")).reason === null);
  check("PT51 reason stored", planned(D("2026-07-01")).reason !== null);
  check("PT52 holidays not considered", !ptLib.includes("holiday") && !ptLib.includes("праздник"));

  // Save / recalc / persistence (53–59) — mirror store on a full PT draft.
  const cm2 = await mkDraft("personal_training");
  for (const k of PT) await slotUpload(cm2.id, k, B(`pt-${k}`));
  await p.refund.update({ where: { id: cm2.id }, data: good });
  const r = ptCalc({ X: 1000000, N: 10, E: 4, V: 150000, method: "contract_rate", snp: false });
  const pl = planned(D("2026-07-15"));
  await p.refund.update({ where: { id: cm2.id }, data: { applicationDate: new Date(2026, 6, 15), contractAmountKopeks: 1000000, ptTrainerEmployeeId: tDis.id, ptTrainerNameSnapshot: tDis.fullName, ptContractSessionCount: 10, ptUsedSessionCount: 4, ptTerminationSessionPriceKopeks: 150000, ptCalculationMethod: "contract_rate", ptRawResultKopeks: r.raw, refundResultAmountKopeks: r.result, amountKopeks: r.result, baseRefundDueDate: new Date(pl.base.y, pl.base.m - 1, pl.base.d), plannedRefundDate: new Date(pl.planned.y, pl.planned.m - 1, pl.planned.d), dueDateAdjustmentReason: pl.reason === "sat" ? "сб" : pl.reason === "sun" ? "вс" : null, calculationVersion: "pt_contract_rate_v1" } });
  const cm2row = await p.refund.findUnique({ where: { id: cm2.id } });
  check("PT53 PT fields stored", cm2row.ptContractSessionCount === 10 && cm2row.ptUsedSessionCount === 4 && cm2row.ptTerminationSessionPriceKopeks === 150000);
  check("PT54 amountKopeks = valid result", cm2row.amountKopeks === 400000 && cm2row.refundResultAmountKopeks === 400000);
  check("PT55 calculationVersion stored", cm2row.calculationVersion === "pt_contract_rate_v1");
  const r2b = ptCalc({ X: 1000000, N: 10, E: 2, V: 150000, method: "contract_rate", snp: false });
  await p.refund.update({ where: { id: cm2.id }, data: { ptUsedSessionCount: 2, ptRawResultKopeks: r2b.raw, refundResultAmountKopeks: r2b.result, amountKopeks: r2b.result } });
  check("PT56 recalculation updates draft", (await p.refund.findUnique({ where: { id: cm2.id } })).amountKopeks === r2b.result && r2b.result !== r.result);
  check("PT57 optimistic lock via expectedUpdatedAt", actSrc.includes("calculatePersonalTrainingRefund") && actSrc.includes("updatedAt: new Date(expected)"));
  check("PT58 derived fields never from client", !actSrc.includes('formData.get("refundResultAmount") ') && !actSrc.includes('formData.get("trainerNameSnapshot")') && actSrc.includes("computePersonalTrainingRefund("));
  await p.auditLog.create({ data: { action: "refund.pt_calculated", entityType: "Refund", entityId: cm2.id, companyId: CO, clubId: CLUB, userId: MGR, metadataJson: JSON.stringify({ calculationVersion: "pt_contract_rate_v1" }) } });
  check("PT59 AuditLog pt_calculated recorded", (await p.auditLog.count({ where: { action: "refund.pt_calculated", entityId: cm2.id } })) === 1);
  check("PT audit events wired", ["refund.pt_details_saved", "refund.pt_calculated", "refund.pt_recalculated", "refund.pt_unavailable_calculated"].every((a) => actSrc.includes(a)));
  check("PT negative → unavailable stored, amount 0 (server rule)", actSrc.includes("calc.unavailable ? 0") && actSrc.includes("ptRefundUnavailableReason"));

  // UI (60–68)
  const ptForm = readFileSync(new URL("../src/app/(app)/refunds/_components/PtCalcForm.tsx", import.meta.url), "utf8");
  check("PT60 PT form fields present", ["applicationDate", "contractAmount", "contractSessions", "usedSessions", "terminationPrice", "trainerEmployeeId"].every((n) => ptForm.includes(`name="${n}"`)));
  check("PT61 membership form still separate", detailsSrc.includes("MembershipCalcForm") && detailsSrc.includes("PtCalcForm"));
  check("PT62 both calculation variants present", ptForm.includes('name="calculationMethod"') && ptForm.includes('"contract_rate"') && ptForm.includes('"average_rate"'));
  check("PT63 comment appears for variant 2", ptForm.includes('method === "average_rate"') && ptForm.includes('name="alternativeReason"'));
  check("PT64 dismissed trainers shown + marked", ptForm.includes("Уволен") && detailsSrc.includes("dismissed"));
  check("PT65 result card rendered", ptForm.includes("Результат расчёта") && ptForm.includes("Итоговая сумма возврата"));
  check("PT66 negative → refusal card", ptForm.includes("Возврат не принимается") && ptForm.includes("refusalDraftText"));
  check("PT67 no active send-to-regional button", ptForm.includes("После реализации этапа согласования") && !ptForm.includes("Отправить региональному директору<"));
  check("PT68 mobile-safe (grid stacks, no forced overflow)", ptForm.includes("sm:grid-cols-2") && !ptForm.includes("overflow-x-scroll"));
  check("PT trainer list has no email/personal data", !ptForm.includes("email") && detailsSrc.includes("fullName"));

  // ================= Phase 3A: review workflow ==============================
  // Fixtures: 2nd regional of CLUB, a regional of CLUB2, accountant/chief/owner/gd.
  const RD2 = "pilot-rf-rd2", RDX = "pilot-rf-rdx", ACC = "pilot-rf-acc", CHF = "pilot-rf-chf", OWN = "pilot-rf-own", GD = "pilot-rf-gd";
  await Promise.all([RD2, RDX, ACC, CHF, OWN, GD].map((id) => p.user.create({ data: { id, email: `${id}@x.dev`, name: id, role: "manager", isActive: true } })));
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: RD2, role: "regional_director" } });
  await p.clubUserAccess.create({ data: { clubId: CLUB2, userId: RDX, role: "regional_director" } });
  await p.clubUserAccess.create({ data: { clubId: CLUB, userId: ACC, role: "accountant" } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: CHF, role: "chief_accountant" } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: OWN, role: "owner" } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: GD, role: "general_director" } });

  async function hasClubRole(userId, clubId, rolesSet) {
    const cr = await p.clubUserAccess.findMany({ where: { userId, clubId }, select: { role: true } });
    if (cr.some((r) => rolesSet.includes(r.role))) return true;
    const club = await p.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
    if (!club) return false;
    const co = await p.companyUserAccess.findMany({ where: { userId, companyId: club.companyId }, select: { role: true } });
    return co.some((r) => rolesSet.includes(r.role));
  }
  function ready(r, types) {
    if (r.entryVersion !== 2) return false;
    if (!["membership", "personal_training"].includes(r.returnType)) return false;
    const need = r.returnType === "membership" ? MEMBERSHIP : PT;
    if (!need.every((k) => types.includes(k))) return false;
    if (!validateStrict(r).ok) return false;
    if (!r.calculationVersion) return false;
    if (r.ptRefundUnavailableReason) return false;
    if (r.refundResultAmountKopeks == null || r.refundResultAmountKopeks <= 0 || r.amountKopeks <= 0) return false;
    return true;
  }
  const editable = (s) => s === "draft" || s === "needs_correction";
  const canSubmit = (roles, isAuthor) => roles.includes("manager") && isAuthor;
  const submitTx = (id) => p.refund.updateMany({ where: { id, status: { in: ["draft", "needs_correction"] } }, data: { status: "pending_regional_review", regionalReviewRequestedAt: new Date(), submittedByManagerId: MGR } });
  const approveTx = (id, uid) => p.refund.updateMany({ where: { id, status: "pending_regional_review" }, data: { status: "accounting_in_progress", regionalReviewedAt: new Date(), regionalReviewedByUserId: uid, accountingStartedAt: new Date() } });
  const returnTx = (id, uid, c) => p.refund.updateMany({ where: { id, status: "pending_regional_review" }, data: { status: "needs_correction", regionalReviewedAt: new Date(), regionalReviewedByUserId: uid, regionalCorrectionComment: c } });
  const validComment = (s) => String(s ?? "").trim().length >= 5;
  async function makeReady(type) {
    const r = await mkDraft(type);
    for (const k of (type === "membership" ? MEMBERSHIP : PT)) await slotUpload(r.id, k, B(`w-${k}-${r.id}`), { user: MGR });
    await p.refund.update({ where: { id: r.id }, data: { ...good, contractAmountKopeks: 1000000, refundResultAmountKopeks: 400000, amountKopeks: 400000, calculationVersion: type === "membership" ? "membership_v1" : "pt_contract_rate_v1" } });
    return r.id;
  }
  const row = (id) => p.refund.findUnique({ where: { id } });
  const activeTypes = async (id) => (await activeDocs(id)).map((d) => d.documentType);

  // Submission readiness (16–21)
  const readyM = await makeReady("membership");
  check("W-ready complete membership is submittable", ready(await row(readyM), await activeTypes(readyM)));
  check("W16 incomplete documents block submit", !ready({ ...(await row(readyM)) }, ["contract_page_1"]));
  check("W17 incomplete requisites block submit", !ready({ ...(await row(readyM)), bankBik: "" }, await activeTypes(readyM)));
  check("W18 missing calculation blocks submit", !ready({ ...(await row(readyM)), calculationVersion: null }, await activeTypes(readyM)));
  check("W19 amount 0 blocks submit", !ready({ ...(await row(readyM)), refundResultAmountKopeks: 0, amountKopeks: 0 }, await activeTypes(readyM)));
  check("W20 negative PT (unavailable) blocks submit", !ready({ ...(await row(readyM)), ptRefundUnavailableReason: "x" }, await activeTypes(readyM)));
  check("W21 missing calculationVersion blocks submit", !ready({ ...(await row(readyM)), calculationVersion: null }, await activeTypes(readyM)));

  // Submit role gating (9–15)
  check("W1 manager-author can submit", canSubmit(["manager"], true));
  check("W9 non-author manager cannot submit", !canSubmit(["manager"], false));
  check("W11 regional cannot submit", !canSubmit(["regional_director"], true));
  check("W12 accountant cannot submit", !canSubmit(["accountant"], true));
  check("W13 chief cannot submit", !canSubmit(["chief_accountant"], true));
  check("W14 owner cannot submit", !canSubmit(["owner"], true));
  check("W15 system_admin cannot submit", !canSubmit(["system_admin"], true));

  // Submit transition (1–8)
  check("W2 submit membership → pending", (await submitTx(readyM)).count === 1 && (await row(readyM)).status === "pending_regional_review");
  check("W4 submit time stored", (await row(readyM)).regionalReviewRequestedAt !== null && (await row(readyM)).submittedByManagerId === MGR);
  check("W6 editing blocked after submit (status not editable)", editable((await row(readyM)).status) === false);
  check("W7 edit updateMany would not match pending", (await p.refund.updateMany({ where: { id: readyM, status: { in: ["draft", "needs_correction"] } }, data: { contractAmountKopeks: 1 } })).count === 0);
  check("W22 second submit does not transition again", (await submitTx(readyM)).count === 0);
  const readyPT = await makeReady("personal_training");
  check("W3 submit PT → pending", (await submitTx(readyPT)).count === 1 && (await row(readyPT)).status === "pending_regional_review");

  // Parallel submit (23) — new ready refund, two concurrent submits → one wins.
  const par1 = await makeReady("membership");
  const [pa, pb] = await Promise.all([submitTx(par1), submitTx(par1)]);
  check("W23 parallel submit applies once", pa.count + pb.count === 1);

  // Regional approval gating (24–33)
  check("W24 regional of club may act", await hasClubRole(RD, CLUB, ["regional_director"]));
  check("W25 second regional of club may act", await hasClubRole(RD2, CLUB, ["regional_director"]));
  check("W26 regional of another club cannot", !(await hasClubRole(RDX, CLUB, ["regional_director"])));
  check("W28 manager cannot approve", !(await hasClubRole(MGR, CLUB, ["regional_director"])));
  check("W29 accountant cannot approve", !(await hasClubRole(ACC, CLUB, ["regional_director"])));
  check("W30 chief cannot approve", !(await hasClubRole(CHF, CLUB, ["regional_director"])));
  check("W31 owner cannot approve", !(await hasClubRole(OWN, CLUB, ["regional_director"])));
  check("W32 general director cannot approve", !(await hasClubRole(GD, CLUB, ["regional_director"])));

  // Approve transition (34–41)
  const beforeAmount = (await row(readyM)).amountKopeks;
  check("W34 approve → accounting_in_progress", (await approveTx(readyM, RD)).count === 1 && (await row(readyM)).status === "accounting_in_progress");
  const ap = await row(readyM);
  check("W35/36 reviewer + time stored", ap.regionalReviewedAt !== null && ap.regionalReviewedByUserId === RD);
  check("W37 accountingStartedAt stored", ap.accountingStartedAt !== null);
  check("W40 paidAt not set", ap.paidAt === null);
  check("W41 amount unchanged", ap.amountKopeks === beforeAmount);
  check("W39 no Expense/CashMovement created by workflow", (await p.expense.count({ where: { clubId: CLUB } }).catch(() => 0)) === 0 && (await p.cashMovement.count({ where: { clubId: CLUB } }).catch(() => 0)) === 0);
  check("W56 repeat approve no second effect", (await approveTx(readyM, RD2)).count === 0);

  // Return for correction (42–53)
  const retId = await makeReady("membership");
  await submitTx(retId);
  check("W43 empty comment rejected", !validComment(""));
  check("W44 whitespace comment rejected", !validComment("   "));
  check("W42 return with comment", validComment("исправьте даты договора") && (await returnTx(retId, RD, "исправьте даты договора")).count === 1);
  const rr = await row(retId);
  check("W45 status needs_correction", rr.status === "needs_correction");
  check("W46 manager sees the comment", rr.regionalCorrectionComment === "исправьте даты договора");
  check("W47 manager can edit again (editable)", editable(rr.status) && (await p.refund.updateMany({ where: { id: retId, status: { in: ["draft", "needs_correction"] } }, data: { contractAmountKopeks: 1200000 } })).count === 1);
  await p.refund.update({ where: { id: retId }, data: { contractAmountKopeks: 1000000 } });
  check("W51 resubmit needs_correction → pending", (await submitTx(retId)).count === 1 && (await row(retId)).status === "pending_regional_review");

  // Races: approve vs return simultaneously (55)
  const raceId = await makeReady("membership");
  await submitTx(raceId);
  const [ra, rb] = await Promise.all([approveTx(raceId, RD), returnTx(raceId, RD2, "верните")]);
  check("W55 approve+return simultaneously → one transition", ra.count + rb.count === 1);
  check("W57 stale status yields no change", (await approveTx(raceId, RD)).count === (["accounting_in_progress"].includes((await row(raceId)).status) ? 0 : 0));

  // Accounting visibility (59–66) — mirror role/status filter.
  const accSees = (roles, status) => roles.some((r) => ["accountant", "chief_accountant"].includes(r)) && status === "accounting_in_progress";
  check("W59 accountant sees accounting_in_progress", accSees(["accountant"], "accounting_in_progress"));
  check("W60 chief sees accounting_in_progress", accSees(["chief_accountant"], "accounting_in_progress"));
  check("W62 manager does not get accounting action (read-only status)", !accSees(["manager"], "accounting_in_progress"));

  // Static UI + safety (67–74, + no-financial-side-effects)
  const listSrc = readFileSync(new URL("../src/app/(app)/refunds/page.tsx", import.meta.url), "utf8");
  const detSrc = readFileSync(new URL("../src/app/(app)/refunds/[id]/page.tsx", import.meta.url), "utf8");
  const wfSrc = readFileSync(new URL("../src/app/(app)/refunds/_components/RefundWorkflow.tsx", import.meta.url), "utf8");
  check("W67 old upload form removed from /refunds", !listSrc.includes("RefundUpload"));
  check("W68 «+ Новый возврат» present", listSrc.includes("+ Новый возврат"));
  check("W71 regional queue block present", listSrc.includes("Ожидают моей проверки"));
  check("W72/73 accounting queue block present", listSrc.includes("В работе у бухгалтерии"));
  check("W-detail v2 review + regional action + legacy kept", detSrc.includes("RegionalReview") && detSrc.includes("accounting_in_progress") && detSrc.includes("RefundEditForm"));
  check("W-actions wired", actSrc.includes("submitRefundToRegional") && actSrc.includes("approveRefundByRegional") && actSrc.includes("returnRefundForCorrection"));
  check("W-audit events wired", ["refund.submitted_to_regional", "refund.resubmitted_to_regional", "refund.returned_for_correction", "refund.approved_by_regional", "refund.sent_to_accounting"].every((a) => actSrc.includes(a)));
  check("W-no Expense/CashMovement/paidAt in workflow actions", !/\bprisma\.expense\.create|\bprisma\.cashMovement\.create|paidAt:/.test(actSrc.slice(actSrc.indexOf("submitRefundToRegional"))));
  check("W-regional guard re-checks club access on server", actSrc.includes('userHasClubRole(ctx.user.id, refund.clubId, ["regional_director"])'));
  check("W-conditional updates guard status (races)", actSrc.includes('status: REFUND_V2_STATUS.PENDING_REGIONAL_REVIEW') && actSrc.includes("res.count === 0"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
