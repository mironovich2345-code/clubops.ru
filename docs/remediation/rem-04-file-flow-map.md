# REM-04 — File Flow Map (write/read graph)

The canonical lifecycle for every uploaded blob, and per-module divergences. Captured at `ca7f5b1`.

## Canonical write → read graph
```
upload (multipart)                     download (GET route)
  │                                       │
  ├─ validate actor / role / scope        ├─ authenticate session
  ├─ validate declared MIME + size        ├─ authorize entity (getXForContext + club/company scope)
  ├─ read bytes → Buffer                  ├─ validate storageKey against the module regex
  ├─ magic-byte signature check           ├─ getStorage().get(key)  → Buffer | null
  ├─ server-generate storageKey           ├─ if null → controlled "missing_object" (not bare 404)
  ├─ getStorage().put(key, buf, mime)     ├─ safeDownloadHeaders(key, name, forceAttachment)
  ├─ create metadata row (sha256/size)    │     (Content-Type from server key ext; nosniff; no-store)
  ├─ link to entity                       └─ documentResponse(range-aware 200/206)
  └─ audit
                       delete / archive / replacement
                         └─ soft tombstone (removedAt/removedBy/reason) or field clear;
                            blob delete is NOT part of the normal financial-doc UI flow.
```

## Per-module detail
| Module | Storage backend | Metadata model | Company scope | Entity scope | Blob lifecycle | Deletion semantics | Backup status (pre-REM-04) |
|---|---|---|---|---|---|---|---|
| **Invoices** | `getStorage()` (local\|s3) | `Invoice.storageKey` + `PendingInvoiceUpload` | `companyId` | `invoiceId` | put once on create/analyze; consumed via compare-and-set | field cleared on remove | **none** (metadata in DB dump only) |
| **Expenses (legacy)** | `getStorage()` | `Expense.originalFileStorageKey` | `companyId`/`clubId` | `expenseId` | put once | field cleared | none |
| **Expenses v2** | `getStorage()` | `ExpenseDocument` | `companyId`/`clubId` | `expenseId` | put once/doc, ≤N docs | **soft tombstone** | none |
| **Refunds v1** | `getStorage()` | `Refund.documentsJson[]` | `companyId` | `refundId` | put/file | JSON edit | none |
| **Refunds v2** | `getStorage()` | `RefundDocument` (per slot) | `companyId` | `refundId` | put/slot | soft / **superseded** | none |
| **Payroll proof** | `getStorage()` (reuses expense/refund helpers) | Expense/Refund docs | `companyId`/`clubId` | period/calc | put once | soft | none |
| **AI source files** | in-memory buffer (no separate blob store) | — | request-scoped | invoice/expense | analyzed, not re-stored | n/a | n/a |
| **Company / legal documents** | none today (no dedicated model) | — | — | — | — | — | n/a |
| **Cash operations** | `getStorage()` | `CashOperationDocument` | `companyId`/`clubId` | cash op | put 1–3 docs | soft | none |
| **Sales reports** | `getStorage()` | `SalesReportDocument` | `companyId`/`clubId` | report | put ≤20 | field-level | none |
| **Exports** (xlsx/csv) | generated on the fly, streamed; **not persisted** | — | request | — | ephemeral | n/a | n/a |
| **Temporary files** | none persisted (buffers in memory) | — | — | — | ephemeral | n/a | n/a |

## Consistency observations (feed REM-04 design)
1. **No tenant prefix in keys** → a leaked/guessed key is not a tenant boundary; authorization is the
   only boundary (which is correct), but the key gives no defense-in-depth. REM-04 §5 adds a
   `<env>/<companyId>/…` prefix for new/migrated objects.
2. **`put` overwrites** in both providers → no immutability guard for financial documents (REM-04 §9).
3. **Two-step consistency is manual**: put-then-create-row. A put that succeeds followed by a failed
   row insert leaves an **orphan blob**; a row whose blob put failed leaves a **dangling metadata**
   pointer. Only invoices have a structured pending/consume guard. REM-04 §7 introduces a
   pending→active→failed state + an `uploadOperationKey` idempotency handle so a retry is a no-op and
   orphans are detectable (§11 inventory).
4. **No verification field**: nothing records that a blob's presence/size/hash was ever confirmed
   after upload (REM-04 §8 `verificationStatus`/`verifiedAt`).
5. **Backup status = none for blobs**: the REM-03 DB dump restores every row above but **zero bytes**
   of any blob. Full-system recovery is impossible until REM-04 (§12–14, §22).

## Authorization boundary (unchanged by REM-04)
Every download route already resolves the entity under the caller's company/club scope BEFORE
fetching bytes, and validates the key against a module-specific regex. **REM-04 does not touch file
authorization, tenant scope, or the business workflows** — it hardens storage durability, key
structure, integrity, and recovery only.
