# Database Backup Alerts (REM-03)

| Signal | Threshold | Severity | Source |
|---|---|---|---|
| No successful backup within RPO | > 26h since last verified backup | **S0** | backup-list age / manifest |
| Scheduled backup did not run | timer fired but no new object | S1 | systemd + list |
| Backup failed (any) | non-zero exit / errorCode | S1 | journald backup-database.mjs |
| Upload / checksum / remote-verify failed | any | S1 | errorCode UPLOAD_FAILED / REMOTE_VERIFY_FAILED |
| Suspicious size deviation | dump below MIN or far below previous | S2 | manifest dumpSizeBytes trend |
| Retention failure | lifecycle/worker error | S2 | provider |
| Pre-deploy backup failed | deploy aborted | S1 | deploy.sh |
| Restore rehearsal overdue | no restoreTestedAt in 30d | S2 | manifest |

Bootstrap cheaply: alert on the newest `backup:list` object being older than 26h or missing; alert on any
non-zero exit of the backup service in journald. Never log secret values (the tool redacts them).
