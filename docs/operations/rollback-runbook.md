# CLUB-OPS — Rollback Runbook

Read-only assessment + procedure at `dc14d10`. **Never** `prisma migrate reset` or any destructive
rollback on production.

## What rollback exists today
- **App rollback: automatic + manual.** On a failed health check `deploy.sh:257` re-`compose up -d app`
  on the **previous image** (recorded in `STATE_FILE`). Manually: `APP_IMAGE=<prev-digest> compose up -d app caddy`.
- **DB rollback: none by design** (`deploy.sh:8,262`). The applied migration is **not** reverted; Prisma
  has no down-migrations. Recovery from a bad migration = **restore the pre-deploy `pg_dump`** (manual).

## Can we roll back?
| Question | Answer |
|---|---|
| Return to previous image/commit? | **Yes** — previous image digest in `STATE_FILE`; `compose up -d app` on it. |
| Is the old app compatible with the new (additive) schema? | **Yes, generally** — all recent migrations are additive (`migration-risk-register.md`), so the previous app runs fine against the migrated DB (extra columns/tables are ignored). |
| Which migrations make rollback impossible? | **None so far** (no `DROP`/type-change). A future destructive migration (drop column, rename, `SET NOT NULL`, unique on populated data) **would** break the old app → that class requires expand/contract, never a bare deploy. |

## Procedure — bad APP deploy (schema fine)
1. Confirm the new app is unhealthy (`/api/health` non-200, errors in logs).
2. `cd /opt/club-ops` → `APP_IMAGE="$(cat .deployed_image_prev || <prev-digest>)" APP_DEPLOYMENT_ID=... compose up -d app caddy` (the auto-rollback in `deploy.sh` already attempts this).
3. Verify `/api/health` 200 + a smoke check (`post-deploy-checklist.md`).
4. Stop the systemd deploy timer if the bad image is still `:main` (`systemctl stop club-ops-deploy.timer`) to prevent re-pulling it, until the image is fixed/reverted in CI.

## Procedure — bad DATA migration (schema/data damaged)
1. **Stop writes:** stop the app container (`compose stop app`) so no new writes land on the damaged schema. (There is no in-app read-only/maintenance mode — see OPS/incident.)
2. Identify the pre-deploy backup: newest `/opt/club-ops/backups/clubops_<ts>.dump` **older than the bad migrate** (the backup is taken *before* migrate, so it predates the damage).
3. On a **disposable** instance first, `pg_restore` and run `audit:data-integrity` + `audit:financial-reconciliation` to confirm the backup is clean (never restore blindly onto prod).
4. Restore to production only after the disposable verification: coordinate a maintenance window, `pg_restore --clean --if-exists` into the postgres volume (or a fresh DB), point the app at it.
5. Re-run reconciliation on the restored prod DB; record RPO (data since the backup timestamp is **lost** — quantify it) and RTO.
6. Post-mortem: why did the migration pass staging? (Staging rehearsal, `staging-migration-rehearsal.md`, is the gate that should have caught it.)

## Gaps (feed OPS)
- **No in-app "stop writes" / maintenance mode** — containment is "stop the container", which is blunt (also stops reads). Money incidents (double-payment) have no finer freeze (OPS-018).
- **DB rollback = restore only**, and the restore is **unproven** (OPS-001) → a bad data migration currently has an *unverified* recovery path. Prove the restore (Part A of `backup-restore-rehearsal.md`) before relying on this.
- First deploy has no app-rollback target.
