# CLUB-OPS — File Security Review (upload / download / traversal / XSS)

Read-only at `eb8a8f6`. `file-access-results.json`. **Verdict: strong and consistent.** One latent
finding (CSV formula injection) and one weak binding (client `storageKey`).

## Download authorization — all 5 routes SAFE
Every route requires `getCurrentAccessContext()` (401 if none) and authorizes the **entity through a
tenant-scoped loader** before touching storage; the storageKey is re-derived from a row already proven
in-scope. No raw-id file fetch.
| Route | Guard |
|---|---|
| `invoices/[id]/file` | `getInvoiceForContext` → streams `invoice.originalFileStorageKey` |
| `expenses/[id]/file` | `getExpenseForContext` → streams `expense.originalFileStorageKey` |
| `refunds/[id]/file` | `getRefundForContext`; `?key` cross-checked to belong to the refund (`refundDocument.findFirst({refundId, storageKey, removedAt:null})`) → foreign key = 404 |
| `sales-reports/[id]/file` | role gate + `getSalesReportForContext`; `?key` cross-checked to the report's docs |
| `expenses/[id]/documents/[docId]` | scoped parent + `doc.expenseId===expense.id` + defensive companyId/clubId match |
- **No cross-tenant download**: substituting entity id, docId, or `?key` fails. Content-Type/Disposition from a **server-set extension allowlist** (only jpg/png/webp/pdf inline; else `attachment`); `X-Content-Type-Options: nosniff`; RFC-6266 filename with ASCII fallback (no header injection). `Cache-Control: private, no-store`. 404-vs-403 does not leak existence.

## Upload validation — SAFE
Declared-MIME allowlist (jpg/png/webp/pdf) + size limit (10MB; reports 15MB) + **magic-byte sniffing**
(`sniffDocumentSignature`/`validateSignature` — detected MIME must equal declared; HEIC/SVG/HTML/script
rejected) on the live `persist*` paths. **Stored key is server-derived** random hex
(`${prefix}/${randomBytes(16|32)}.${ext}`), never the client filename; original filename kept as display
metadata only (path components stripped). xlsx import is bounded (5MB/8 sheets/5000 rows/64 cols, bounded
`!ref`) — decompression-bomb/ReDoS hardened around `xlsx` 0.18.5.
- Note: the non-`persist` `store*File` variants don't sniff but are **not used** by live actions — flag so a future caller doesn't reintroduce a gap.

## Path traversal — SAFE (defense in depth)
`isSafeStorageKey` (`storage/types.ts:38`) rejects empty/>256, leading `/`, `..`, backslash, and requires
`^[a-z0-9._-]+/[a-z0-9._-]+$` — null bytes/encoded/Windows separators all fail. `local-provider.resolve()`
calls it **before** `join(UPLOAD_ROOT, key)`; s3-provider re-checks on every op; each `read*File`
additionally applies a strict per-category hex regex. Traversal not reachable.

## XSS — SAFE
The **only** `dangerouslySetInnerHTML` is a static, nonce-guarded `THEME_INIT` script (`layout.tsx:58`) —
no user input. No `innerHTML`; React auto-escapes all user text (supplier/counterparty names, subjects,
comments, employee/client names, AI fields, audit metadata). No `javascript:` sinks; hrefs are internal
routes or the scoped download API.

## Findings
- **SEC-010 (S3, CSV formula injection):** `csv.ts:6 escapeCell` quotes only `" , \n \r`; it does **not**
  neutralize a leading `= + - @` formula prefix. User free-text (vendor/counterparty/comment/client
  name) flows into `exports.ts` builders. **Latent** — the CSV export routes are currently hard-404, so
  no live HTTP caller; but the vulnerable builder is wired and exposed the moment an export is
  re-enabled. Fix = prefix risky cells with `'`.
- **SEC-006 (S2, client-trusted storageKey):** expense v1 `saveExpense` (`expenses/actions.ts:343`) and
  payroll `savePayrollStatement` persist `originalFileStorageKey` verbatim from FormData with no
  proof-of-ownership (unlike invoices' server-owned single-use `PendingInvoiceUpload` consume). A caller
  can bind their own record to another tenant's blob key; the download route then streams it because the
  **parent record** is in-scope. Bounded by 128/256-bit key unguessability. Fix = a server-issued,
  company-scoped upload token binding the key.

**Bottom line:** file access is well-designed (scoped routes, validated uploads, no traversal, no XSS).
Close SEC-010 before enabling any CSV export; tighten SEC-006's storageKey binding.
