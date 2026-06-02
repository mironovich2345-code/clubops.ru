/*
  Warnings:

  - Added the required column `companyId` to the `Club` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `Expense` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `Invoice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `Sale` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- Seed a demo company so pre-existing rows can be backfilled (local SQLite beta).
INSERT INTO "Company" ("id", "name", "createdAt", "updatedAt")
VALUES ('demo-company', 'Демо компания', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inn" TEXT,
    "ogrn" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LegalEntity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClubLegalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClubLegalEntity_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClubLegalEntity_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompanyUserAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CompanyUserAccess_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CompanyUserAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClubUserAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClubUserAccess_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClubUserAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT,
    "clubId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Club" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Club_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Club" ("city", "createdAt", "id", "name", "updatedAt", "companyId") SELECT "city", "createdAt", "id", "name", "updatedAt", 'demo-company' FROM "Club";
DROP TABLE "Club";
ALTER TABLE "new_Club" RENAME TO "Club";
CREATE INDEX "Club_companyId_idx" ON "Club"("companyId");
CREATE TABLE "new_Expense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "vendorName" TEXT,
    "amountKopeks" INTEGER NOT NULL,
    "expenseDate" DATETIME NOT NULL,
    "paymentMethod" TEXT,
    "comment" TEXT,
    "fileUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Expense_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Expense_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Expense_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Expense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Expense" ("amountKopeks", "category", "clubId", "comment", "createdAt", "createdByUserId", "expenseDate", "fileUrl", "id", "paymentMethod", "updatedAt", "vendorName", "companyId") SELECT "amountKopeks", "category", "clubId", "comment", "createdAt", "createdByUserId", "expenseDate", "fileUrl", "id", "paymentMethod", "updatedAt", "vendorName", 'demo-company' FROM "Expense";
DROP TABLE "Expense";
ALTER TABLE "new_Expense" RENAME TO "Expense";
CREATE INDEX "Expense_companyId_idx" ON "Expense"("companyId");
CREATE INDEX "Expense_clubId_idx" ON "Expense"("clubId");
CREATE INDEX "Expense_createdByUserId_idx" ON "Expense"("createdByUserId");
CREATE INDEX "Expense_category_idx" ON "Expense"("category");
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");
CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "counterpartyName" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "invoiceDate" DATETIME NOT NULL,
    "dueDate" DATETIME NOT NULL,
    "paidAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'unpaid',
    "comment" TEXT,
    "fileUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Invoice" ("amountKopeks", "clubId", "comment", "counterpartyName", "createdAt", "createdByUserId", "dueDate", "fileUrl", "id", "invoiceDate", "paidAt", "status", "subject", "updatedAt", "companyId") SELECT "amountKopeks", "clubId", "comment", "counterpartyName", "createdAt", "createdByUserId", "dueDate", "fileUrl", "id", "invoiceDate", "paidAt", "status", "subject", "updatedAt", 'demo-company' FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE INDEX "Invoice_companyId_idx" ON "Invoice"("companyId");
CREATE INDEX "Invoice_clubId_idx" ON "Invoice"("clubId");
CREATE INDEX "Invoice_createdByUserId_idx" ON "Invoice"("createdByUserId");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sale_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sale_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Sale_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Sale_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Sale" ("amountKopeks", "clubId", "comment", "createdAt", "createdByUserId", "id", "saleDate", "source", "updatedAt", "companyId") SELECT "amountKopeks", "clubId", "comment", "createdAt", "createdByUserId", "id", "saleDate", "source", "updatedAt", 'demo-company' FROM "Sale";
DROP TABLE "Sale";
ALTER TABLE "new_Sale" RENAME TO "Sale";
CREATE INDEX "Sale_companyId_idx" ON "Sale"("companyId");
CREATE INDEX "Sale_clubId_idx" ON "Sale"("clubId");
CREATE INDEX "Sale_createdByUserId_idx" ON "Sale"("createdByUserId");
CREATE INDEX "Sale_source_idx" ON "Sale"("source");
CREATE INDEX "Sale_saleDate_idx" ON "Sale"("saleDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LegalEntity_companyId_idx" ON "LegalEntity"("companyId");

-- CreateIndex
CREATE INDEX "ClubLegalEntity_clubId_idx" ON "ClubLegalEntity"("clubId");

-- CreateIndex
CREATE INDEX "ClubLegalEntity_legalEntityId_idx" ON "ClubLegalEntity"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubLegalEntity_clubId_legalEntityId_key" ON "ClubLegalEntity"("clubId", "legalEntityId");

-- CreateIndex
CREATE INDEX "CompanyUserAccess_companyId_idx" ON "CompanyUserAccess"("companyId");

-- CreateIndex
CREATE INDEX "CompanyUserAccess_userId_idx" ON "CompanyUserAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyUserAccess_companyId_userId_role_key" ON "CompanyUserAccess"("companyId", "userId", "role");

-- CreateIndex
CREATE INDEX "ClubUserAccess_clubId_idx" ON "ClubUserAccess"("clubId");

-- CreateIndex
CREATE INDEX "ClubUserAccess_userId_idx" ON "ClubUserAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubUserAccess_clubId_userId_role_key" ON "ClubUserAccess"("clubId", "userId", "role");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_idx" ON "AuditLog"("companyId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_idx" ON "AuditLog"("entityType");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
