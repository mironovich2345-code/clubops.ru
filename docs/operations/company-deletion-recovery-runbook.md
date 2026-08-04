# Runbook — Accidental Company Deletion Recovery (DATA-008)

REM-03 does NOT fix DATA-008 (Company hard-delete is still possible and cascades). This is the recovery
flow; the permanent fix (Company soft-delete + guard) is a separate remediation.

1. **Freeze writes** — stop the app container (the only containment today; there is no in-app freeze).
2. **Preserve evidence** — snapshot the current DB + note the deletion time + actor (audit log).
3. **Select a pre-incident backup** (`backup:list`; a backup from before the deletion).
4. **Restore into an ISOLATED disposable DB** (`database-restore-runbook.md`) — never onto production.
5. **Compare the affected tenant** — export the deleted Company's rows from the restored DB.
6. **Decide** (with owner + finance): full-DB restore (loses everything since the backup) vs. controlled
   single-tenant re-import vs. manual reconstruction. **No automatic tenant merge** — OPS-016 tenant restore
   tooling does not exist yet (PARTIALLY CLOSED); a single-tenant import is a future REM.
7. **Audit + communicate** the data-loss window to the affected company.

Do NOT run destructive DELETE/INSERT tenant surgery on production.
