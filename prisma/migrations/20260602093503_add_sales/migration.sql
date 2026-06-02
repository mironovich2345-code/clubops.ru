-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "saleDate" DATETIME NOT NULL,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sale_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sale_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Sale_clubId_idx" ON "Sale"("clubId");

-- CreateIndex
CREATE INDEX "Sale_createdByUserId_idx" ON "Sale"("createdByUserId");

-- CreateIndex
CREATE INDEX "Sale_source_idx" ON "Sale"("source");

-- CreateIndex
CREATE INDEX "Sale_saleDate_idx" ON "Sale"("saleDate");
