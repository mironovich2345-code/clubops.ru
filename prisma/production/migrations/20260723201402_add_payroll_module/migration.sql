-- Non-destructive additive migration (production PostgreSQL) — payroll module.
-- ClubEmployee gets 4 in-place nullable/defaulted columns (NO table rebuild, unlike
-- the SQLite dev variant). 8 new tables + indexes. No DROP/TRUNCATE/DELETE/DROP COLUMN.

-- AlterTable (in place)
ALTER TABLE "ClubEmployee" ADD COLUMN "hireDate" TIMESTAMP(3);
ALTER TABLE "ClubEmployee" ADD COLUMN "preferredPaymentMethod" TEXT;
ALTER TABLE "ClubEmployee" ADD COLUMN "isOfficial" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ClubEmployee" ADD COLUMN "defaultLegalEntityId" TEXT;

-- CreateTable
CREATE TABLE "EmployeeClubAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "earningShareBasisPoints" INTEGER,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmployeeClubAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmployeePayScheme" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "employeeId" TEXT,
    "position" TEXT,
    "schemeType" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmployeePayScheme_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "regionalApprovedAt" TIMESTAMP(3),
    "accountingApprovedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "totalsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollCalculation" (
    "id" TEXT NOT NULL,
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
    "calculatedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollCalculation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollAdvance" (
    "id" TEXT NOT NULL,
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
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedByUserId" TEXT,
    "paidByUserId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollAdvance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "payrollCalculationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "paymentDate" TIMESTAMP(3) NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmployeeFinancialObligation" (
    "id" TEXT NOT NULL,
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
    "dueDate" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmployeeFinancialObligation_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "EmployeeClubAssignment_companyId_idx" ON "EmployeeClubAssignment"("companyId");
CREATE INDEX "EmployeeClubAssignment_clubId_idx" ON "EmployeeClubAssignment"("clubId");
CREATE INDEX "EmployeeClubAssignment_employeeId_idx" ON "EmployeeClubAssignment"("employeeId");
CREATE UNIQUE INDEX "EmployeeClubAssignment_employeeId_clubId_position_key" ON "EmployeeClubAssignment"("employeeId", "clubId", "position");
CREATE INDEX "EmployeePayScheme_companyId_idx" ON "EmployeePayScheme"("companyId");
CREATE INDEX "EmployeePayScheme_clubId_idx" ON "EmployeePayScheme"("clubId");
CREATE INDEX "EmployeePayScheme_employeeId_idx" ON "EmployeePayScheme"("employeeId");
CREATE INDEX "EmployeePayScheme_clubId_effectiveFrom_idx" ON "EmployeePayScheme"("clubId", "effectiveFrom");
CREATE INDEX "PayrollPeriod_companyId_idx" ON "PayrollPeriod"("companyId");
CREATE INDEX "PayrollPeriod_clubId_idx" ON "PayrollPeriod"("clubId");
CREATE INDEX "PayrollPeriod_status_idx" ON "PayrollPeriod"("status");
CREATE UNIQUE INDEX "PayrollPeriod_clubId_year_month_key" ON "PayrollPeriod"("clubId", "year", "month");
CREATE INDEX "PayrollCalculation_companyId_idx" ON "PayrollCalculation"("companyId");
CREATE INDEX "PayrollCalculation_clubId_idx" ON "PayrollCalculation"("clubId");
CREATE INDEX "PayrollCalculation_employeeId_idx" ON "PayrollCalculation"("employeeId");
CREATE INDEX "PayrollCalculation_payrollPeriodId_idx" ON "PayrollCalculation"("payrollPeriodId");
CREATE UNIQUE INDEX "PayrollCalculation_payrollPeriodId_employeeId_key" ON "PayrollCalculation"("payrollPeriodId", "employeeId");
CREATE INDEX "PayrollAdjustment_companyId_idx" ON "PayrollAdjustment"("companyId");
CREATE INDEX "PayrollAdjustment_payrollCalculationId_idx" ON "PayrollAdjustment"("payrollCalculationId");
CREATE INDEX "PayrollAdjustment_employeeId_idx" ON "PayrollAdjustment"("employeeId");
CREATE INDEX "PayrollAdvance_companyId_idx" ON "PayrollAdvance"("companyId");
CREATE INDEX "PayrollAdvance_clubId_idx" ON "PayrollAdvance"("clubId");
CREATE UNIQUE INDEX "PayrollAdvance_employeeId_clubId_periodYear_periodMonth_key" ON "PayrollAdvance"("employeeId", "clubId", "periodYear", "periodMonth");
CREATE INDEX "PayrollPayment_companyId_idx" ON "PayrollPayment"("companyId");
CREATE INDEX "PayrollPayment_clubId_idx" ON "PayrollPayment"("clubId");
CREATE INDEX "PayrollPayment_employeeId_idx" ON "PayrollPayment"("employeeId");
CREATE INDEX "PayrollPayment_payrollCalculationId_idx" ON "PayrollPayment"("payrollCalculationId");
CREATE INDEX "EmployeeFinancialObligation_companyId_idx" ON "EmployeeFinancialObligation"("companyId");
CREATE INDEX "EmployeeFinancialObligation_employeeId_idx" ON "EmployeeFinancialObligation"("employeeId");
CREATE INDEX "EmployeeFinancialObligation_status_idx" ON "EmployeeFinancialObligation"("status");
