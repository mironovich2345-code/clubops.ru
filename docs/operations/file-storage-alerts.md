# File Storage Alerts (REM-04)

Alert matrix for the object-storage subsystem. Severity S0 (page) → S3 (ticket).

| Alert | Signal | Severity | Action |
|---|---|---|---|
| Upload failure spike | 5xx / STORAGE_WRITE_FAILED rate | S1 | check bucket reachability + creds |
| Download failure spike | GET/HEAD failures | S1 | check bucket + signed-URL config |
| **Missing blob** | `audit:file-inventory` FI-01 > 0 | S1 | run file-recovery runbook (object recovery) |
| Hash mismatch | FI-04 > 0 | S0 | corruption/tamper — page; recover from version |
| Cross-tenant key | FI-05 / FI-15 > 0 | S0 | security investigation — page |
| Orphan blobs growing | FI-02 trend | S3 | review after acceptance; lifecycle-clean temp only |
| Bucket unavailable | readiness probe `unreachable`/`timeout` | S1 | provider status; readiness gates traffic with DB |
| Signed URL failure | presign errors | S2 | check TTL/clock/creds |
| Migration incomplete | rows stuck `migrationStatus=pending` > 24h (FI-11) | S2 | resume `migrate:files-to-s3` |
| Versioning disabled | bucket policy check | S1 | re-enable versioning (recovery depends on it) |
| Manifest stale | no `backup:files-manifest` within RPO | S2 | check the scheduler |
| Storage growth threshold | bucket size/objects over budget | S3 | capacity review (`rem-04-final-report` §20) |
| Local in production | FI-09 > 0 or health `storage=local` in prod | S0 | misconfig — page; fail-fast should have blocked boot |

Alerts are value-free (counts, codes) and never include a bucket name, endpoint, key, object
content, or PII.
