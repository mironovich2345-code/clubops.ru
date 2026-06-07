-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClubLegalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClubLegalEntity_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClubLegalEntity_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ClubLegalEntity" ("clubId", "createdAt", "id", "legalEntityId") SELECT "clubId", "createdAt", "id", "legalEntityId" FROM "ClubLegalEntity";
DROP TABLE "ClubLegalEntity";
ALTER TABLE "new_ClubLegalEntity" RENAME TO "ClubLegalEntity";
CREATE INDEX "ClubLegalEntity_clubId_idx" ON "ClubLegalEntity"("clubId");
CREATE INDEX "ClubLegalEntity_legalEntityId_idx" ON "ClubLegalEntity"("legalEntityId");
CREATE UNIQUE INDEX "ClubLegalEntity_clubId_legalEntityId_key" ON "ClubLegalEntity"("clubId", "legalEntityId");
CREATE TABLE "new_LegalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inn" TEXT,
    "kpp" TEXT,
    "ogrn" TEXT,
    "bankName" TEXT,
    "bankBik" TEXT,
    "accountNumber" TEXT,
    "corrAccount" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LegalEntity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LegalEntity" ("accountNumber", "bankName", "companyId", "createdAt", "id", "inn", "name", "ogrn", "type", "updatedAt") SELECT "accountNumber", "bankName", "companyId", "createdAt", "id", "inn", "name", "ogrn", "type", "updatedAt" FROM "LegalEntity";
DROP TABLE "LegalEntity";
ALTER TABLE "new_LegalEntity" RENAME TO "LegalEntity";
CREATE INDEX "LegalEntity_companyId_idx" ON "LegalEntity"("companyId");
CREATE TABLE "new_SalesReportDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesReportId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'other',
    "originalFileName" TEXT NOT NULL,
    "originalFileMime" TEXT NOT NULL,
    "originalFileSize" INTEGER NOT NULL,
    "storageKey" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesReportDocument_salesReportId_fkey" FOREIGN KEY ("salesReportId") REFERENCES "SalesReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SalesReportDocument" ("createdAt", "id", "originalFileMime", "originalFileName", "originalFileSize", "salesReportId", "storageKey", "uploadedByUserId") SELECT "createdAt", "id", "originalFileMime", "originalFileName", "originalFileSize", "salesReportId", "storageKey", "uploadedByUserId" FROM "SalesReportDocument";
DROP TABLE "SalesReportDocument";
ALTER TABLE "new_SalesReportDocument" RENAME TO "SalesReportDocument";
CREATE INDEX "SalesReportDocument_salesReportId_idx" ON "SalesReportDocument"("salesReportId");
CREATE TABLE "new_SalesReportLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesReportId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "legalEntityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesReportLine_salesReportId_fkey" FOREIGN KEY ("salesReportId") REFERENCES "SalesReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SalesReportLine_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SalesReportLine" ("amountKopeks", "createdAt", "id", "key", "label", "salesReportId", "sortOrder", "updatedAt") SELECT "amountKopeks", "createdAt", "id", "key", "label", "salesReportId", "sortOrder", "updatedAt" FROM "SalesReportLine";
DROP TABLE "SalesReportLine";
ALTER TABLE "new_SalesReportLine" RENAME TO "SalesReportLine";
CREATE INDEX "SalesReportLine_salesReportId_idx" ON "SalesReportLine"("salesReportId");
CREATE INDEX "SalesReportLine_legalEntityId_idx" ON "SalesReportLine"("legalEntityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
