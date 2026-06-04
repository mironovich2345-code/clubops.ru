-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "saleDate" DATETIME NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_accountant',
    "submittedByUserId" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" DATETIME,
    "rejectedByUserId" TEXT,
    "rejectedAt" DATETIME,
    "rejectionReason" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sale_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sale_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sale_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Sale_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Sale" ("amountKopeks", "clubId", "comment", "companyId", "createdAt", "createdByUserId", "id", "legalEntityId", "saleDate", "source", "updatedAt") SELECT "amountKopeks", "clubId", "comment", "companyId", "createdAt", "createdByUserId", "id", "legalEntityId", "saleDate", "source", "updatedAt" FROM "Sale";
DROP TABLE "Sale";
ALTER TABLE "new_Sale" RENAME TO "Sale";
CREATE INDEX "Sale_companyId_idx" ON "Sale"("companyId");
CREATE INDEX "Sale_clubId_idx" ON "Sale"("clubId");
CREATE INDEX "Sale_createdByUserId_idx" ON "Sale"("createdByUserId");
CREATE INDEX "Sale_source_idx" ON "Sale"("source");
CREATE INDEX "Sale_saleDate_idx" ON "Sale"("saleDate");
CREATE INDEX "Sale_status_idx" ON "Sale"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Backfill: sales created before the verification workflow are treated as confirmed revenue.
UPDATE "Sale" SET "status" = 'confirmed' WHERE "status" = 'pending_accountant';
