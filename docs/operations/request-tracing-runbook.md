# Request Tracing Runbook (REM-07)

Every response carries `X-Request-Id`; a denied server action returns it inside the safe message
(«…Код обращения: <id>»).

## Support flow (spec §17)
1. Ask the user only for: the **Код обращения** (requestId), the time, the screen, and the action. No
   screenshot with personal data is needed.
2. `npm run trace:request -- <requestId>` → the safe chain of SecurityEvents for that request.
3. From the chain: actor, route/action, reasonCode, tenant scope, deploymentVersion.
4. Explain the outcome to the user without revealing the internal reason or another tenant's data.

## Correlation notes
- The requestId is server-minted (middleware) and never trusted from the client.
- `AuditLog` (successful changes) has no requestId column — correlate a success by actor + time near the
  SecurityEvent, or adopt a requestId column there in a future pass.
- Off-request work (cron/jobs) uses `source=cron/internal` and may have a null requestId.
