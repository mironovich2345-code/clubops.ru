-- Non-destructive additive migration (production PostgreSQL) — regional city payroll.
-- New tables only; no ALTER/DROP/rebuild of existing tables.
CREATE TABLE "RegionalCityPayroll" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "regionalEmployeeId" TEXT,
    "regionalName" TEXT NOT NULL,
    "baseType" TEXT NOT NULL,
    "baseKopeks" INTEGER NOT NULL DEFAULT 0,
    "percentBp" INTEGER NOT NULL DEFAULT 0,
    "accruedKopeks" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ownerApprovedById" TEXT,
    "ownerApprovedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RegionalCityPayroll_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RegionalCityPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "regionalCityPayrollId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "expenseId" TEXT,
    "comment" TEXT,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RegionalCityPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegionalCityPayroll_companyId_city_year_month_key" ON "RegionalCityPayroll"("companyId", "city", "year", "month");
CREATE INDEX "RegionalCityPayroll_companyId_idx" ON "RegionalCityPayroll"("companyId");
CREATE INDEX "RegionalCityPayroll_status_idx" ON "RegionalCityPayroll"("status");
CREATE INDEX "RegionalCityPayment_companyId_idx" ON "RegionalCityPayment"("companyId");
CREATE INDEX "RegionalCityPayment_regionalCityPayrollId_idx" ON "RegionalCityPayment"("regionalCityPayrollId");
CREATE INDEX "RegionalCityPayment_clubId_idx" ON "RegionalCityPayment"("clubId");
