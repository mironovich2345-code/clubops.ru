# REM-04 — File Storage Live Acceptance Checklist

Automated logic proof is done (`test:rem-04-file-storage` 31/31; `pilot:rem-04-durable-file-
storage`). These are the LIVE gates on a real S3-compatible bucket.

- [ ] **G-FILE-1** Production refuses to start on `local` storage (unset/`local` provider → boot fails).
- [ ] **G-FILE-2** Upload lands in S3 (object present, SSE on, tenant-scoped key).
- [ ] **G-FILE-3** A second app instance downloads the just-uploaded file (no local affinity).
- [ ] **G-FILE-4** An invoice PDF opens inline (nosniff, correct Content-Type/Disposition).
- [ ] **G-FILE-5** Expense + refund files open; archived/cancelled entities behave correctly.
- [ ] **G-FILE-6** Downloaded bytes hash == metadata sha256.
- [ ] **G-FILE-7** `audit:file-inventory` detects a deliberately missing blob (FI-01, exit 2).
- [ ] **G-FILE-8** Object recovery from a bucket version/backup works + verifies sha256.
- [ ] **G-FILE-9** `migrate:files-to-s3 --mode=dry-run` plans correctly (no mutation).
- [ ] **G-FILE-10** Migration apply + verify on staging (copy→verify→finalize; local blob kept).
- [ ] **G-FILE-11** DB restore + blobs reconciliation passes (inventory 0 S0/S1).
- [ ] **G-FILE-12** Measured full-system RTO (DB + blobs) recorded.
- [ ] **G-FILE-13** Real iPhone: PDF/image viewer opens documents from S3.
- [ ] **G-FILE-14** Bucket policy reviewed: private, no public ACL, versioning + lifecycle, SSE,
      least-privilege creds separate from the backup bucket.

**Sign-off:** ARCH-017 + SEC-006 close on code + config review; OPS-002 closes on G-FILE-1..8;
OPS-001 (blob half) closes on G-FILE-11..12. Until then OPS-002/OPS-001 stay PARTIALLY CLOSED.
