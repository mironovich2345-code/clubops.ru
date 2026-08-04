-- REM-07: SecurityEvent (denied-authorization + correlation). Additive; no change to
-- AuditLog or any financial/domain table. No backfill (past denials do not exist).
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "outcome" TEXT NOT NULL DEFAULT 'denied',
    "reasonCode" TEXT,
    "actorId" TEXT,
    "companyId" TEXT,
    "clubId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "route" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "metadataJson" TEXT,
    "deploymentVersion" TEXT
);
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");
CREATE INDEX "SecurityEvent_eventType_createdAt_idx" ON "SecurityEvent"("eventType", "createdAt");
CREATE INDEX "SecurityEvent_companyId_createdAt_idx" ON "SecurityEvent"("companyId", "createdAt");
CREATE INDEX "SecurityEvent_actorId_createdAt_idx" ON "SecurityEvent"("actorId", "createdAt");
CREATE INDEX "SecurityEvent_requestId_idx" ON "SecurityEvent"("requestId");
CREATE INDEX "SecurityEvent_severity_createdAt_idx" ON "SecurityEvent"("severity", "createdAt");
