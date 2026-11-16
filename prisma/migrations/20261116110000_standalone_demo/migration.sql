CREATE TABLE "DemoVisit" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "tokenHash" TEXT NOT NULL,
 "companyId" TEXT NOT NULL,
 "usersJson" TEXT NOT NULL,
 "clubsJson" TEXT NOT NULL,
 "expiresAt" DATETIME NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "DemoVisit_tokenHash_key" ON "DemoVisit"("tokenHash");
CREATE UNIQUE INDEX "DemoVisit_companyId_key" ON "DemoVisit"("companyId");
CREATE INDEX "DemoVisit_expiresAt_idx" ON "DemoVisit"("expiresAt");
