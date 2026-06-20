-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClubLegalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClubLegalEntity_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClubLegalEntity_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ClubLegalEntity" ("clubId", "createdAt", "id", "isPrimary", "legalEntityId", "updatedAt") SELECT "clubId", "createdAt", "id", "isPrimary", "legalEntityId", "updatedAt" FROM "ClubLegalEntity";
DROP TABLE "ClubLegalEntity";
ALTER TABLE "new_ClubLegalEntity" RENAME TO "ClubLegalEntity";
CREATE INDEX "ClubLegalEntity_clubId_idx" ON "ClubLegalEntity"("clubId");
CREATE INDEX "ClubLegalEntity_legalEntityId_idx" ON "ClubLegalEntity"("legalEntityId");
CREATE UNIQUE INDEX "ClubLegalEntity_clubId_legalEntityId_key" ON "ClubLegalEntity"("clubId", "legalEntityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
