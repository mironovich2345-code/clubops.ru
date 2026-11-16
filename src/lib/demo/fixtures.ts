import type { Prisma } from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import { demoConfig, DEMO_ROLES, type DemoRole } from "./config";
import { derivedInvoiceStatus } from "@/lib/invoice-payments";
import { calcSalaryByShifts, aggregateCalculation } from "@/lib/payroll/calc";
import { demoReceiptPdf } from "./document";
import { EXP } from "@/lib/expense-simplified";
import { invoiceFinancialFingerprint, invoiceFinancialSnapshot } from "@/lib/invoices";
import { EXPENSE_CATEGORY_OPTIONS } from "@/lib/expenses";

export const DEMO_BRANCHES = [
  { name: "Центральный", net: 180_000_000, plan: 420_000_000, employees: 20 },
  { name: "Северный", net: 135_000_000, plan: 300_000_000, employees: 16 },
  { name: "Южный", net: 105_000_000, plan: 240_000_000, employees: 12 },
] as const;
const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, "0")}T12:00:00Z`);
const part = (total: number, index: number, count: number) => Math.floor(total / count) + (index < total % count ? 1 : 0);

/** Only called inside the admission transaction, on the guarded demo database.
 * No seed.ts bootstrap, common password, production data or external calls.
 */
export async function seedDemoTenant(tx: Prisma.TransactionClient) {
  demoConfig();
  for (const category of EXPENSE_CATEGORY_OPTIONS) await tx.expenseCategory.upsert({ where: { key: category.key }, update: {}, create: { key: category.key, name: category.label, isSystem: true } });
  const company = await tx.company.create({ data: { name: "Сфера (демо)", cashCanonicalCutoverAt: at(1), payrollAdvanceDay: 15, payrollFinalDay: 25, payrollWeekendRule: "shift_earlier", payrollTimezone: "Europe/Moscow" } });
  const companyId = company.id;
  const users = {} as Record<DemoRole, string>;
  for (const role of DEMO_ROLES) {
    const user = await tx.user.create({ data: {
      email: `${randomUUID()}@visitor.invalid`, name: `Демо · ${role}`, role,
      passwordHash: null, emailVerifiedAt: new Date(),
    } });
    users[role] = user.id;
    if (role !== "manager") await tx.companyUserAccess.create({ data: { companyId, userId: user.id, role } });
  }
  const creator = users.manager;
  const clubs: string[] = [];
  for (const [index, branch] of DEMO_BRANCHES.entries()) {
    const club = await tx.club.create({ data: { companyId, name: branch.name, city: "Демоград" } });
    clubs.push(club.id);
    const clubId = club.id;
    const legal = await tx.legalEntity.create({ data: { companyId, type: "ooo", name: `ООО «Сфера ${index + 1}» (вымышленное)`, comment: "Синтетическое юрлицо; банковские реквизиты отсутствуют" } });
    const legalEntityId = legal.id;
    const common = { companyId, clubId, legalEntityId };
    await tx.clubLegalEntity.create({ data: { clubId, legalEntityId } });
    const ip = await tx.legalEntity.create({ data: { companyId, type: "ip", name: `ИП «Сфера ${index + 1}» (вымышленное)`, comment: "Только синтетическая касса; настоящих реквизитов нет" } });
    await tx.clubLegalEntity.create({ data: { clubId, legalEntityId: ip.id } });
    // Manager can switch only between branches of this visitor's tenant.
    if (index === 0) await tx.clubUserAccess.create({ data: { clubId, userId: creator, role: "manager" } });
    await tx.clubUserAccess.create({ data: { clubId, userId: users.regional_director, role: "regional_director" } });
    await tx.salesPlan.create({ data: { companyId, clubId, month: "2026-11", planType: "total", targetAmountKopeks: branch.plan, createdByUserId: users.general_director } });
    for (const [planType, targetAmountKopeks] of [["subscriptions", branch.plan * .7], ["personal_training", branch.plan * .3]] as const) {
      await tx.salesPlan.create({ data: { companyId, clubId, month: "2026-11", planType, targetAmountKopeks, createdByUserId: users.general_director } });
    }
    await tx.balanceSnapshot.create({ data: { ...common, snapshotDate: at(1), actualBalanceKopeks: 20_000_000, createdById: users.accountant, comment: "Синтетический входящий остаток" } });
    const connection = await tx.ofdConnection.create({ data: { companyId, legalEntityId, provider: "taxcom", displayName: `${branch.name} · синтетические чеки`, serverBaseUrl: "https://ofd.invalid", authType: "demo", isActive: false, createdByUserId: users.owner } });
    // 45 receipts and 45 fiscal returns. Aggregates are derived from those rows.
    // Internal refund applications below are separate entities, never deducted here.
    for (let d = 0; d < 15; d++) {
      const date = `2026-11-${String(d + 1).padStart(2, "0")}`;
      const returned = part(4_000_000, d, 15);
      const net = part(branch.net, d, 15);
      for (const [operationType, total] of [["income", net + returned], ["income_return", returned]] as const) {
        const cash = Math.floor(total / 4);
        const receipt = await tx.ofdReceiptImport.create({ data: {
          ...common, connectionId: connection.id, provider: "taxcom", fnNumber: `DEMO-${index + 1}`,
          fiscalDocumentNumber: (d + 1) * 2 + (operationType === "income" ? 0 : 1), operationType,
          receiptDate: at(d + 1), totalKopeks: total, cashKopeks: cash, electronicKopeks: total - cash,
          dedupeKey: `${companyId}:${clubId}:${date}:${operationType}`, source: "synthetic-demo",
        } });
        for (const [category, weight] of [["membership", 60], ["personal_training", 25], ["other", 15]] as const) {
          const amount = category === "other" ? total - Math.floor(total * .6) - Math.floor(total * .25) : Math.floor(total * weight / 100);
          const label = { membership: "Основные услуги", personal_training: "Дополнительные услуги", other: "Товары" }[category];
          await tx.ofdReceiptItem.create({ data: { ...common, receiptImportId: receipt.id, provider: "taxcom", date, fnNumber: `DEMO-${index + 1}`, fdNumber: receipt.fiscalDocumentNumber, lineIndex: weight,
            itemName: `${label} (демо)`, normalizedItemName: `${label} (демо)`.toLowerCase(), totalKopeks: amount, priceKopeks: amount,
            operationType, revenueCategoryCode: category, revenueCategoryName: label, itemKey: `${receipt.id}:${category}` } });
        }
      }
      const receipts = await tx.ofdReceiptImport.findMany({ where: { companyId, clubId, receiptDate: at(d + 1) } });
      const income = receipts.find((r) => r.operationType === "income")!;
      const ret = receipts.find((r) => r.operationType === "income_return")!;
      await tx.ofdDailySalesSummary.create({ data: { ...common, provider: "taxcom", date, summaryKey: `${companyId}:${clubId}:${date}`,
        incomeTotalKopeks: income.totalKopeks, incomeCashKopeks: income.cashKopeks, incomeElectronicKopeks: income.electronicKopeks,
        returnTotalKopeks: ret.totalKopeks, returnCashKopeks: ret.cashKopeks, returnElectronicKopeks: ret.electronicKopeks,
        netTotalKopeks: income.totalKopeks - ret.totalKopeks, receiptCount: 1, returnReceiptCount: 1 } });
      for (const category of ["membership", "personal_training", "other"]) {
        const items = await tx.ofdReceiptItem.findMany({ where: { companyId, clubId, date, revenueCategoryCode: category } });
        const i = items.find((r) => r.operationType === "income")!;
        const r = items.find((r) => r.operationType === "income_return")!;
        await tx.ofdRevenueCategoryDailySummary.create({ data: { ...common, provider: "taxcom", date, categoryCode: category, categoryName: i.revenueCategoryName,
          incomeTotalKopeks: i.totalKopeks, returnTotalKopeks: r.totalKopeks, netTotalKopeks: i.totalKopeks - r.totalKopeks,
          itemCount: 2, receiptCount: 2, summaryKey: `${companyId}:${clubId}:${date}:${category}` } });
      }
    }
    // Recognized expenses = invoices 1,200,000 + cash expenses 480,000 = 1,680,000 RUB.
    // Draft payroll and pending internal refunds are not recognized a second time.
    for (let d = 0; d < 5; d++) await tx.expense.create({ data: { ...common, createdByUserId: creator, paidByUserId: creator,
      amountKopeks: 3_200_000, category: "household", expenseDate: at(2 + d * 3), status: "verified", entryVersion: 2,
      paymentMethod: d % 2 ? "cash" : "bank", vendorName: `Демо-поставщик ${d + 1}`, generatedTitle: "Материалы для филиала (демо)",
      submittedAt: at(2 + d * 3), verifiedAt: at(2 + d * 3), verifiedByUserId: users.accountant, comment: "Вымышленная операция" } });
    const pendingExpense = await tx.expense.create({ data: { ...common, createdByUserId: creator, amountKopeks: 125_000, category: "household", expenseDate: at(15), status: EXP.PENDING_ACCOUNTANT, entryVersion: 2, generatedTitle: "Проверить закупку (демо)", paymentMethod: "cash", submittedAt: at(15) } });
    const pdf = demoReceiptPdf();
    await tx.expenseDocument.create({ data: { companyId, clubId, expenseId: pendingExpense.id, storageKey: `expense-docs/dede${createHash("sha256").update(pendingExpense.id).digest("hex").slice(4)}.pdf`, originalFilename: "synthetic-demo.pdf", safeFilename: "synthetic-demo.pdf", mimeType: "application/pdf", sizeBytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), uploadedByUserId: creator, storageProvider: "local", verificationStatus: "verified", verifiedAt: at(15) } });
    for (const [category, amount] of [["rent", 60_000_000], ["household", 20_000_000], ["salary", 20_000_000]] as const) await tx.budget.create({ data: { companyId, clubId, category, month: "2026-11", limitAmountKopeks: amount, createdByUserId: users.owner } });
    const invoices = [
      { amount: 15_000_000, paid: 15_000_000, due: 10 },
      { amount: 10_000_000, paid: 5_000_000, due: 25 },
      { amount: 5_000_000, paid: 0, due: 5 },
      { amount: 10_000_000, paid: 0, due: 28 },
    ];
    for (const [n, fixture] of invoices.entries()) {
      const status = derivedInvoiceStatus(fixture.paid, fixture.amount, "approved_by_regional", "approved_by_regional");
      const invoice = await tx.invoice.create({ data: { ...common, createdByUserId: creator, counterpartyName: `Демо-снабжение ${n + 1}`,
        amountKopeks: fixture.amount, expenseCategory: "rent", expensePeriod: "2026-11", subject: "Услуги филиала (вымышленные)", invoiceNumber: `DEMO-${index + 1}-${n + 1}`,
        invoiceDate: at(1), dueDate: at(fixture.due), paidAt: status === "paid" ? at(10) : null, status, prePaymentStatus: "approved_by_regional", confidence: "high", aiDataReviewedAt: at(1), aiDataReviewedById: users.regional_director } });
      await tx.invoice.update({ where: { id: invoice.id }, data: { approvedDataFingerprint: invoiceFinancialFingerprint(invoiceFinancialSnapshot(invoice)) } });
      if (fixture.paid) await tx.invoicePayment.create({ data: { companyId, invoiceId: invoice.id, amountKopeks: fixture.paid, paymentDate: at(10), source: "bank", method: "bank", createdById: users.accountant, comment: "Демо: учёт платежа без отправки денег" } });
    }
    const period = await tx.payrollPeriod.create({ data: { companyId, clubId, year: 2026, month: 11, status: "draft", createdByUserId: creator } });
    for (let n = 0; n < branch.employees; n++) {
      const position = ["administrator", "sales_manager", "night_manager", "manager"][n % 4];
      const employee = await tx.clubEmployee.create({ data: { companyId, clubId, fullName: `Демо Сотрудник ${index + 1}-${String(n + 1).padStart(2, "0")}`, position, status: "active", hireDate: at(1), defaultLegalEntityId: legalEntityId, comment: "Вымышленный сотрудник" } });
      await tx.employeeClubAssignment.create({ data: { companyId, clubId, employeeId: employee.id, position, startDate: at(1) } });
      const params = { baseKopeks: 3_000_000 + n * 50_000, shiftNorm: 15 };
      const calc = calcSalaryByShifts(params, { actualShifts: 7 });
      const totals = aggregateCalculation({ automaticKopeks: calc.amountKopeks, adjustments: [], advanceKopeks: 0, otherPaymentsKopeks: 0 });
      await tx.employeePayScheme.create({ data: { companyId, clubId, employeeId: employee.id, schemeType: "salary_by_shifts", paramsJson: JSON.stringify(params), effectiveFrom: at(1), createdByUserId: creator } });
      await tx.payrollCalculation.create({ data: { ...common, payrollPeriodId: period.id, employeeId: employee.id, roleSnapshot: position, schemeSnapshotJson: JSON.stringify({ schemeType: "salary_by_shifts", params }),
        baseSalaryKopeks: params.baseKopeks, shifts: 7, automaticAmountKopeks: calc.amountKopeks, ...totals, status: "draft", detailsJson: JSON.stringify({ breakdown: calc.breakdown, flags: calc.flags, warnings: calc.warnings, inputJson: JSON.stringify({ actualShifts: 7 }) }), calculatedAt: at(15) } });
    }
    await tx.refund.create({ data: { ...common, createdByUserId: creator, clientName: `Демо Клиент ${index + 1}`, amountKopeks: 50_000, refundResultAmountKopeks: 50_000, reason: "Отказ от дополнительной услуги (демо)", refundDate: at(15), plannedRefundDate: at(20), status: "needs_review", entryVersion: 1, contractNumber: `DEMO-R-${index + 1}` } });
    await tx.mandatoryPaymentPlan.create({ data: { ...common, category: "utilities", title: "Коммунальные услуги (демо)", amountKopeks: 1_500_000, dueDate: at(27), recurrence: "once", createdByUserId: users.owner } });
  }
  return { companyId, users, clubs };
}
