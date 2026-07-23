-- CreateTable
CREATE TABLE "EmployeeClubAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "earningShareBasisPoints" INTEGER,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmployeePayScheme" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeId" TEXT,
    "position" TEXT,
    "schemeType" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" DATETIME,
    "regionalApprovedAt" DATETIME,
    "accountingApprovedAt" DATETIME,
    "closedAt" DATETIME,
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "totalsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PayrollCalculation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "roleSnapshot" TEXT,
    "schemeSnapshotJson" TEXT,
    "baseSalaryKopeks" INTEGER NOT NULL DEFAULT 0,
    "shifts" INTEGER,
    "hours" INTEGER,
    "salesBaseKopeks" INTEGER NOT NULL DEFAULT 0,
    "revenueBaseKopeks" INTEGER NOT NULL DEFAULT 0,
    "profitBaseKopeks" INTEGER NOT NULL DEFAULT 0,
    "planKopeks" INTEGER,
    "actualKopeks" INTEGER,
    "completionBp" INTEGER,
    "automaticAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "bonusesKopeks" INTEGER NOT NULL DEFAULT 0,
    "deductionsKopeks" INTEGER NOT NULL DEFAULT 0,
    "advancesKopeks" INTEGER NOT NULL DEFAULT 0,
    "grossAccruedKopeks" INTEGER NOT NULL DEFAULT 0,
    "netPayableKopeks" INTEGER NOT NULL DEFAULT 0,
    "paidKopeks" INTEGER NOT NULL DEFAULT 0,
    "remainingKopeks" INTEGER NOT NULL DEFAULT 0,
    "employeeDebtKopeks" INTEGER NOT NULL DEFAULT 0,
    "companyDebtKopeks" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "detailsJson" TEXT,
    "manualOverrideKopeks" INTEGER,
    "manualOverrideReason" TEXT,
    "calculatedAt" DATETIME,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "payrollCalculationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "comment" TEXT,
    "documentKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PayrollAdvance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "earnedToDateKopeks" INTEGER NOT NULL DEFAULT 0,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "cashSource" TEXT,
    "documentKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByUserId" TEXT,
    "paidByUserId" TEXT,
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PayrollPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "payrollCalculationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "paymentDate" DATETIME NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentKey" TEXT,
    "statementId" TEXT,
    "bankTransactionId" TEXT,
    "cashMovementId" TEXT,
    "comment" TEXT,
    "paidByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmployeeFinancialObligation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT,
    "payrollPeriodId" TEXT,
    "direction" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "originalAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "outstandingAmountKopeks" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "dueDate" DATETIME,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClubEmployee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dismissedAt" DATETIME,
    "comment" TEXT,
    "hireDate" DATETIME,
    "preferredPaymentMethod" TEXT,
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "defaultLegalEntityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClubEmployee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClubEmployee_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ClubEmployee" ("clubId", "comment", "companyId", "createdAt", "dismissedAt", "fullName", "id", "position", "status", "updatedAt") SELECT "clubId", "comment", "companyId", "createdAt", "dismissedAt", "fullName", "id", "position", "status", "updatedAt" FROM "ClubEmployee";
DROP TABLE "ClubEmployee";
ALTER TABLE "new_ClubEmployee" RENAME TO "ClubEmployee";
CREATE INDEX "ClubEmployee_companyId_idx" ON "ClubEmployee"("companyId");
CREATE INDEX "ClubEmployee_clubId_idx" ON "ClubEmployee"("clubId");
CREATE INDEX "ClubEmployee_clubId_position_status_idx" ON "ClubEmployee"("clubId", "position", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "EmployeeClubAssignment_companyId_idx" ON "EmployeeClubAssignment"("companyId");

-- CreateIndex
CREATE INDEX "EmployeeClubAssignment_clubId_idx" ON "EmployeeClubAssignment"("clubId");

-- CreateIndex
CREATE INDEX "EmployeeClubAssignment_employeeId_idx" ON "EmployeeClubAssignment"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeClubAssignment_employeeId_clubId_position_key" ON "EmployeeClubAssignment"("employeeId", "clubId", "position");

-- CreateIndex
CREATE INDEX "EmployeePayScheme_companyId_idx" ON "EmployeePayScheme"("companyId");

-- CreateIndex
CREATE INDEX "EmployeePayScheme_clubId_idx" ON "EmployeePayScheme"("clubId");

-- CreateIndex
CREATE INDEX "EmployeePayScheme_employeeId_idx" ON "EmployeePayScheme"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeePayScheme_clubId_effectiveFrom_idx" ON "EmployeePayScheme"("clubId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PayrollPeriod_companyId_idx" ON "PayrollPeriod"("companyId");

-- CreateIndex
CREATE INDEX "PayrollPeriod_clubId_idx" ON "PayrollPeriod"("clubId");

-- CreateIndex
CREATE INDEX "PayrollPeriod_status_idx" ON "PayrollPeriod"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_clubId_year_month_key" ON "PayrollPeriod"("clubId", "year", "month");

-- CreateIndex
CREATE INDEX "PayrollCalculation_companyId_idx" ON "PayrollCalculation"("companyId");

-- CreateIndex
CREATE INDEX "PayrollCalculation_clubId_idx" ON "PayrollCalculation"("clubId");

-- CreateIndex
CREATE INDEX "PayrollCalculation_employeeId_idx" ON "PayrollCalculation"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollCalculation_payrollPeriodId_idx" ON "PayrollCalculation"("payrollPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCalculation_payrollPeriodId_employeeId_key" ON "PayrollCalculation"("payrollPeriodId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_companyId_idx" ON "PayrollAdjustment"("companyId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_payrollCalculationId_idx" ON "PayrollAdjustment"("payrollCalculationId");

-- CreateIndex
CREATE INDEX "PayrollAdjustment_employeeId_idx" ON "PayrollAdjustment"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollAdvance_companyId_idx" ON "PayrollAdvance"("companyId");

-- CreateIndex
CREATE INDEX "PayrollAdvance_clubId_idx" ON "PayrollAdvance"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAdvance_employeeId_clubId_periodYear_periodMonth_key" ON "PayrollAdvance"("employeeId", "clubId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "PayrollPayment_companyId_idx" ON "PayrollPayment"("companyId");

-- CreateIndex
CREATE INDEX "PayrollPayment_clubId_idx" ON "PayrollPayment"("clubId");

-- CreateIndex
CREATE INDEX "PayrollPayment_employeeId_idx" ON "PayrollPayment"("employeeId");

-- CreateIndex
CREATE INDEX "PayrollPayment_payrollCalculationId_idx" ON "PayrollPayment"("payrollCalculationId");

-- CreateIndex
CREATE INDEX "EmployeeFinancialObligation_companyId_idx" ON "EmployeeFinancialObligation"("companyId");

-- CreateIndex
CREATE INDEX "EmployeeFinancialObligation_employeeId_idx" ON "EmployeeFinancialObligation"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeFinancialObligation_status_idx" ON "EmployeeFinancialObligation"("status");
