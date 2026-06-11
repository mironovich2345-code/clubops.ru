-- CreateTable
CREATE TABLE "MandatoryPaymentPlan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amountKopeks" INTEGER NOT NULL DEFAULT 0,
    "dueDayOfMonth" INTEGER,
    "dueDate" TIMESTAMP(3),
    "recurrence" TEXT NOT NULL DEFAULT 'monthly',
    "responsibleUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MandatoryPaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MandatoryPaymentPlan_companyId_idx" ON "MandatoryPaymentPlan"("companyId");

-- CreateIndex
CREATE INDEX "MandatoryPaymentPlan_clubId_idx" ON "MandatoryPaymentPlan"("clubId");

-- AddForeignKey
ALTER TABLE "MandatoryPaymentPlan" ADD CONSTRAINT "MandatoryPaymentPlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MandatoryPaymentPlan" ADD CONSTRAINT "MandatoryPaymentPlan_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MandatoryPaymentPlan" ADD CONSTRAINT "MandatoryPaymentPlan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MandatoryPaymentPlan" ADD CONSTRAINT "MandatoryPaymentPlan_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

