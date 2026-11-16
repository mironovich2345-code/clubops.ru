import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
process.loadEnvFile('.env.demo.local');
const require = createRequire(import.meta.url);
const request = require('./_stubs/demo-request.cjs');
for (const [name, stub] of [['next/headers', request], ['next/cache', require('./_stubs/demo-cache.cjs')]]) {
  const id=require.resolve(name); require.cache[id]={id,filename:id,loaded:true,exports:stub};
}
const jiti = require('jiti')(import.meta.url, { alias: {
  '@': resolve('src'), 'server-only': resolve('scripts/_stubs/server-only.cjs'),
  'next/headers': resolve('scripts/_stubs/demo-request.cjs'),
  'next/cache': resolve('scripts/_stubs/demo-cache.cjs'),
}, interopDefault: true });
jiti('@/lib/demo/config.ts').demoConfig();
const { prisma: db } = jiti('@/lib/prisma.ts');
const { seedDemoTenant } = jiti('@/lib/demo/fixtures.ts');
const { purgeDemoVisit } = jiti('@/lib/demo/visits.ts');
const { createSession } = jiti('@/lib/session.ts');
const { getCurrentAccessContext } = jiti('@/lib/access.ts');
const payroll = jiti('@/app/(app)/payroll/periods/actions.ts');
const schemes = jiti('@/app/(app)/payroll/actions.ts');
const advances = jiti('@/app/(app)/payroll/advance-actions.ts');
const budgets = jiti('@/app/(app)/budgets/actions.ts');
const expenses = jiti('@/app/(app)/expenses/simplified-actions.ts');
const refunds = jiti('@/app/(app)/refunds/refund-document-actions.ts');
const legacyExpenses = jiti('@/app/(app)/expenses/actions.ts');
const { prepareDemoDocuments } = jiti('@/lib/demo/documents.ts');
const { getBudgetFactReportForScope, computeUsedKopeks } = jiti('@/lib/budgets.ts');
const { loadRecognizedExpenses } = jiti('@/lib/finance/recognized-expense.ts');
const { loadPaymentObligationsForScope } = jiti('@/lib/payment-obligations.ts');
const analytics = jiti('@/lib/analytics.ts');
const { calculateProfit } = jiti('@/lib/finance/profit.ts');
const visits = [];
const results = [];
const outbound = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { outbound.push(String(args[0])); throw new Error('QA_EXTERNAL_OUTBOUND_FORBIDDEN'); };
const form = values => { const fd = new FormData(); for (const [k,v] of Object.entries(values)) if (v != null) fd.set(k, String(v)); return fd; };
const ok = (result, label) => assert.equal(result?.ok, true, `${label}: ${JSON.stringify(result)}`);
const denied = (result, label) => assert.equal(result?.ok, false, `${label}: expected denial`);
const check = async (name, fn) => {
  try { await fn(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ name, status: 'failed', error: e.message }); console.error(`FAIL ${name}: ${e.message}`); throw e; }
};
const recognized = v => loadRecognizedExpenses({ companyId: v.companyId, allowedClubIds: v.clubs, months: ['2026-11'] });
const calendar = v => loadPaymentObligationsForScope({ companyId: v.companyId, clubIds: v.clubs, loadEnd: new Date(2026,11,1), monthKey: '2026-11' });
async function tenant() {
  const seed = await db.$transaction(tx => seedDemoTenant(tx), { timeout: 60_000 });
  const visit = await db.demoVisit.create({ data: { tokenHash: randomBytes(32).toString('hex'), companyId: seed.companyId, usersJson: JSON.stringify(seed.users), clubsJson: JSON.stringify(seed.clubs), expiresAt: new Date(Date.now()+7_200_000) } });
  visits.push(visit);
  const sessions = {};
  for (const [role,id] of Object.entries(seed.users)) {
    const cookie = new Map([['scope_company',seed.companyId],['scope_club',seed.clubs[0]]]);
    await request.run(cookie, () => createSession(id, visit.expiresAt));
    sessions[role] = cookie;
  }
  return { ...seed, visit, as: (role, fn) => request.run(sessions[role], fn) };
}
try {
  const a = await tenant(); const b = await tenant();
  for (const role of ['owner','manager','accountant','regional_director']) await check(`AUTH ${role}: ordinary session and scoped role`, async () => {
    const ctx = await a.as(role, getCurrentAccessContext); assert.equal(ctx.selectedCompanyId,a.companyId); assert(ctx.effectiveRoles.includes(role));
  });
  const period = await db.payrollPeriod.findFirst({ where: { companyId: a.companyId, clubId: a.clubs[0] } });
  let calc = await db.payrollCalculation.findFirst({ where: { payrollPeriodId: period.id }, orderBy: { createdAt:'asc' } });
  await check('PAYROLL seeded scheme snapshot supports real recalculation', async () => {
    ok(await a.as('manager', () => payroll.saveCalculationInputs(undefined, form({ calculationId:calc.id, actualShifts:10 }))), 'recompute');
    calc=await db.payrollCalculation.findUnique({where:{id:calc.id}}); assert.equal(calc.automaticAmountKopeks,2_000_000); assert.equal(calc.netPayableKopeks,2_000_000);
  });
  await check('PAYROLL owner/accountant cannot edit calculation inputs', async () => {
    for (const role of ['owner','accountant']) denied(await a.as(role,()=>payroll.saveCalculationInputs(undefined,form({calculationId:calc.id,actualShifts:1}))),role);
  });
  await check('PAYROLL foreign calculation/period and branch are denied', async () => {
    const foreign = await db.payrollCalculation.findFirst({where:{companyId:b.companyId}});
    denied(await a.as('manager',()=>payroll.saveCalculationInputs(undefined,form({calculationId:foreign.id,actualShifts:1}))),'foreign');
    const otherBranch = await db.payrollCalculation.findFirst({where:{companyId:a.companyId,clubId:a.clubs[1]}});
    denied(await a.as('manager',()=>payroll.saveCalculationInputs(undefined,form({calculationId:otherBranch.id,actualShifts:1}))),'other branch');
  });
  await check('PAYROLL all employees calculate, owner changes only future motivation', async () => {
    const all=await db.payrollCalculation.findMany({where:{payrollPeriodId:period.id}});
    for (const c of all) ok(await a.as('manager',()=>payroll.saveCalculationInputs(undefined,form({calculationId:c.id,actualShifts:10}))),'roster calculate');
    const payload={employeeId:calc.employeeId,clubId:a.clubs[0],schemeType:'fixed_salary',effectiveMonth:'2026-12',baseRubles:'45000'};
    denied(await a.as('manager',()=>schemes.savePayScheme(undefined,form(payload))),'manager scheme');
    denied(await a.as('accountant',()=>schemes.savePayScheme(undefined,form(payload))),'accountant scheme');
    ok(await a.as('owner',()=>schemes.savePayScheme(undefined,form(payload))),'owner scheme');
    assert.equal((await db.payrollCalculation.findUnique({where:{id:calc.id}})).automaticAmountKopeks,2_000_000);
  });
  await check('PAYROLL new motivation applies to December only, November snapshot remains intact', async()=>{
    const next=await a.as('manager',()=>payroll.createPayrollPeriod(undefined,form({clubId:a.clubs[0],month:'2026-12'})));ok(next,'December period');
    await a.as('manager',()=>payroll.generateCalculations(form({periodId:next.periodId})));
    const future=await db.payrollCalculation.findFirst({where:{payrollPeriodId:next.periodId,employeeId:calc.employeeId}});
    ok(await a.as('manager',()=>payroll.saveCalculationInputs(undefined,form({calculationId:future.id}))),'fixed salary');
    assert.equal((await db.payrollCalculation.findUnique({where:{id:future.id}})).netPayableKopeks,4_500_000);
    assert.equal((await db.payrollCalculation.findUnique({where:{id:calc.id}})).netPayableKopeks,2_000_000);
  });
  await check('PAYROLL manager submits, regional reviews, accountant approves; owner denied', async () => {
    for (const [role,action] of [['owner','submit'],['accountant','submit']]) denied(await a.as(role,()=>payroll.transitionPeriod(undefined,form({periodId:period.id,action}))),role);
    for (const [role,action] of [['manager','submit'],['regional_director','start_regional_review'],['regional_director','regional_approve'],['accountant','start_accounting_review'],['accountant','accounting_approve']]) {
      ok(await a.as(role,()=>payroll.transitionPeriod(undefined,form({periodId:period.id,action}))),action);
      if (['regional_approve','start_accounting_review','accounting_approve'].includes(action)) {
        const total=await db.payrollCalculation.aggregate({where:{payrollPeriodId:period.id},_sum:{netPayableKopeks:true}});
        assert.equal((await recognized(a)).totalKopeks,168_000_000+total._sum.netPayableKopeks,'accrual disappears between review statuses');
      }
    }
    assert.equal((await db.payrollPeriod.findUnique({where:{id:period.id}})).status,'approved');
    const obligations=(await calendar(a)).obligations.filter(o=>o.sourceType==='payroll'); assert(obligations.length>0,'salary missing in payment calendar'); assert(obligations.every(o=>o.dueDate),'salary calendar has no due date');
  });
  let advanceId;
  await check('PAYROLL advance approval and partial tranche update remaining once', async () => {
    const data={employeeId:calc.employeeId,clubId:a.clubs[0],month:'2026-11',approvedAmount:'5000',earnedToDate:'20000',comment:'Синтетический аванс QA'};
    denied(await a.as('owner',()=>advances.createApprovedAdvance(undefined,form(data))),'owner advance');
    const adv=await a.as('manager',()=>advances.createApprovedAdvance(undefined,form(data)));ok(adv,'advance');advanceId=adv.notice;
    const payload={advanceId,method:'bank',amount:'3000',idempotencyKey:randomUUID()};
    denied(await a.as('manager',()=>advances.addAdvanceTranche(undefined,form(payload))),'manager bank');
    ok(await a.as('accountant',()=>advances.addAdvanceTranche(undefined,form(payload))),'tranche');
    ok(await a.as('accountant',()=>advances.addAdvanceTranche(undefined,form(payload))),'tranche retry');
    calc=await db.payrollCalculation.findUnique({where:{id:calc.id}});assert.equal(calc.advancesKopeks,300_000);assert.equal(calc.remainingKopeks,1_700_000);
    assert.equal(await db.payrollAdvancePayment.count({where:{employeeAdvanceId:advanceId}}),1);
    const total=await db.payrollCalculation.aggregate({where:{payrollPeriodId:period.id},_sum:{remainingKopeks:true}});
    assert.equal((await calendar(a)).obligations.filter(o=>o.sourceType==='payroll').reduce((s,o)=>s+o.amountKopeks,0),total._sum.remainingKopeks,'calendar remains stale after advance');
    denied(await a.as('accountant',()=>advances.addAdvanceTranche(undefined,form({...payload,amount:'2001',idempotencyKey:randomUUID()}))),'advance exceeds approved');
  });
  await check('PAYROLL final payout is idempotent, bounded and linked to one Expense', async () => {
    const payload={calculationId:calc.id,method:'bank',amount:'17000',idempotencyKey:randomUUID()};
    denied(await a.as('owner',()=>payroll.recordPayment(undefined,form(payload))),'owner payment');
    denied(await a.as('manager',()=>payroll.recordPayment(undefined,form(payload))),'manager bank');
    denied(await a.as('accountant',()=>payroll.recordPayment(undefined,form({...payload,amount:'17001'}))),'overpayment');
    const concurrent=await Promise.all([a.as('accountant',()=>payroll.recordPayment(undefined,form(payload))),a.as('accountant',()=>payroll.recordPayment(undefined,form(payload)))]);
    concurrent.forEach(r=>ok(r,'concurrent idempotent final'));
    calc=await db.payrollCalculation.findUnique({where:{id:calc.id}});assert.equal(calc.remainingKopeks,0);assert.equal(calc.paidKopeks,2_000_000);
    const rows=await db.payrollPayment.findMany({where:{payrollCalculationId:calc.id}});assert.equal(rows.length,1);assert(rows[0].expenseId);
    const expense=await db.expense.findUnique({where:{id:rows[0].expenseId}});assert.equal(expense.amountKopeks,1_700_000);assert.equal(expense.category,'salary');
  });
  await check('PAYROLL accrual and cash payments never double recognized expenses', async () => {
    const gross=await db.payrollCalculation.aggregate({where:{payrollPeriodId:period.id},_sum:{netPayableKopeks:true}});
    assert.equal((await recognized(a)).totalKopeks,168_000_000+gross._sum.netPayableKopeks);
    assert.equal(await computeUsedKopeks(a.clubs[0],'salary','2026-11'),gross._sum.netPayableKopeks);
    const fact=await getBudgetFactReportForScope(a.companyId,[a.clubs[0]],'2026-11');
    assert.equal(fact.find(r=>r.category==='salary').actualKopeks,gross._sum.netPayableKopeks);
  });
  await check('PAYROLL paid period cannot be declared before all balances are settled', async () => {
    denied(await a.as('manager',()=>payroll.transitionPeriod(undefined,form({periodId:period.id,action:'mark_paid'}))),'unpaid roster');
  });
  await check('PAYROLL cash payout uses branch IP and one cash expense; accountant denied',async()=>{
    const other=await db.payrollCalculation.findFirst({where:{payrollPeriodId:period.id,id:{not:calc.id}}});
    const payload={calculationId:other.id,method:'cash',amount:'1000',idempotencyKey:randomUUID()};
    denied(await a.as('accountant',()=>payroll.recordPayment(undefined,form(payload))),'accountant cash');
    ok(await a.as('manager',()=>payroll.recordPayment(undefined,form(payload))),'manager cash');
    const payment=await db.payrollPayment.findFirst({where:{payrollCalculationId:other.id}});assert(payment.expenseId);
    assert.equal((await db.legalEntity.findUnique({where:{id:payment.legalEntityId}})).type,'ip');
    const expense=await db.expense.findUnique({where:{id:payment.expenseId}});assert.equal(expense.paymentMethod,'cash');assert.equal(expense.amountKopeks,100_000);
    assert.equal((await db.payrollCalculation.findUnique({where:{id:other.id}})).remainingKopeks,other.remainingKopeks-100_000);
  });
  await check('BUDGET owner plans each branch; manager/accountant and foreign scope denied', async () => {
    const payload={clubId:a.clubs[0],category:'household',month:'2026-11',limitAmount:'200000',amount:'200000'};
    for(const role of ['manager','accountant']) denied(await a.as(role,()=>budgets.createOrUpdateBudget(undefined,form(payload))),role);
    denied(await a.as('owner',()=>budgets.createOrUpdateBudget(undefined,form({...payload,clubId:b.clubs[0]}))),'foreign');
    ok(await a.as('owner',()=>budgets.createOrUpdateBudget(undefined,form(payload))),'owner plan');
    assert.equal(await computeUsedKopeks(a.clubs[0],'household','2026-11'),16_000_000);
  });
  let overrunExpenseId, requestId;
  await check('BUDGET overrun creates pending request and is not recognized before approval', async () => {
    const before=(await recognized(a)).totalKopeks;
    const result=await a.as('manager',()=>legacyExpenses.saveExpense(undefined,form({clubId:a.clubs[0],type:'manual',category:'household',amount:'60000',expenseDate:'2026-11-15',paymentMethod:'cash',comment:'Синтетический перерасход QA'})));
    ok(result,'overrun expense');
    const request=await db.budgetApprovalRequest.findFirst({where:{companyId:a.companyId,status:'pending'},orderBy:{createdAt:'desc'}});
    assert(request,'pending budget approval missing'); requestId=request.id; overrunExpenseId=request.sourceId;
    assert.equal(request.overrunKopeks,2_000_000);assert.equal((await recognized(a)).totalKopeks,before);
    for(const role of ['manager','accountant']) await assert.rejects(()=>a.as(role,()=>budgets.approveBudgetRequest(form({requestId}))));
    await assert.rejects(()=>b.as('owner',()=>budgets.approveBudgetRequest(form({requestId}))));
    await a.as('owner',()=>budgets.approveBudgetRequest(form({requestId})));
    assert.equal((await recognized(a)).totalKopeks,before+6_000_000);
    const fact=await getBudgetFactReportForScope(a.companyId,[a.clubs[0]],'2026-11');
    const row=fact.find(r=>r.category==='household');assert.equal(row.actualKopeks,22_000_000);assert.equal(row.status,'over_budget');
    const period=analytics.resolveMonthPeriod('2026-11',new Date(2026,10,15));
    const report=analytics.buildAnalyticsReport(await analytics.loadAnalyticsData(a.companyId,a.clubs,period),period,'day');
    assert.equal(report.summary.expensesKopeks,(await recognized(a)).totalKopeks,'analytics diverges from budget/finance');
    await assert.rejects(()=>a.as('owner',()=>budgets.approveBudgetRequest(form({requestId}))));
  });
  await check('BUDGET plan update changes variance, never historical fact or another branch', async () => {
    const before=await computeUsedKopeks(a.clubs[0],'household','2026-11');
    ok(await a.as('owner',()=>budgets.createOrUpdateBudget(undefined,form({clubId:a.clubs[0],category:'household',month:'2026-11',limitAmount:'250000',amount:'250000'}))),'raise plan');
    const row=(await getBudgetFactReportForScope(a.companyId,[a.clubs[0]],'2026-11')).find(r=>r.category==='household');
    assert.equal(row.actualKopeks,before);assert.equal(row.budgetKopeks,25_000_000);assert.equal(row.status,'normal');
    assert.equal((await db.budget.findFirst({where:{clubId:a.clubs[1],category:'household'}})).limitAmountKopeks,20_000_000);
  });
  await check('BUDGET current simplified expense can be created, documented and reviewed', async () => {
    const data={category:'household',amount:'1000',expenseDate:'2026-11-15',comment:'Синтетический текущий расход'};
    const result=await a.as('manager',()=>expenses.createSimplifiedExpenseDraft(undefined,form(data)));ok(result,'simple draft');
    const expenseId=result.expenseId;assert(expenseId);
    denied(await a.as('accountant',()=>prepareDemoDocuments('expense',expenseId)),'accountant docs');
    ok(await a.as('manager',()=>prepareDemoDocuments('expense',expenseId)),'synthetic receipt');
    ok(await a.as('manager',()=>expenses.submitExpense(undefined,form({expenseId}))),'submit simple');
    ok(await a.as('regional_director',()=>expenses.approveRegionalBudget(undefined,form({expenseId}))),'regional simple');
    ok(await a.as('accountant',()=>expenses.verifyExpense(undefined,form({expenseId}))),'verify simple');
    assert.equal((await db.expense.findUnique({where:{id:expenseId}})).status,'verified');
  });
  let refundId, refundAmount;
  await check('REFUND manager creates v2 draft; owner/accountant cannot originate it', async () => {
    const payload={clubId:a.clubs[0],returnType:'membership'};
    for(const role of ['owner','accountant']) denied(await a.as(role,()=>refunds.createRefundDraft(undefined,form(payload))),role);
    const result=await a.as('manager',()=>refunds.createRefundDraft(undefined,form(payload)));ok(result,'refund create');refundId=result.refundId;
    denied(await a.as('manager',()=>refunds.submitRefundToRegional(undefined,form({refundId}))),'incomplete submit');
    denied(await b.as('manager',()=>prepareDemoDocuments('refund',refundId)),'foreign docs');
    ok(await a.as('manager',()=>prepareDemoDocuments('refund',refundId)),'synthetic refund documents');
  });
  const refundInput=()=>form({refundId,serviceStartDate:'2026-11-01',serviceEndDate:'2026-11-30',applicationDate:'2026-11-15',contractAmount:'30000'});
  await check('REFUND calculation, stale result protection and correction/resubmission', async () => {
    ok(await a.as('manager',()=>refunds.calculateMembershipRefund(undefined,refundInput())),'calculate');
    const row=await db.refund.findUnique({where:{id:refundId}});refundAmount=row.amountKopeks;assert.equal(refundAmount,Math.ceil(30_000*15/29)*100);
    ok(await a.as('manager',()=>refunds.saveMembershipInputs(undefined,form({refundId,serviceStartDate:'2026-11-01',serviceEndDate:'2026-11-30',applicationDate:'2026-11-15',contractAmount:'31000'}))),'edit input');
    denied(await a.as('manager',()=>refunds.submitRefundToRegional(undefined,form({refundId}))),'stale calculate');
    ok(await a.as('manager',()=>refunds.calculateMembershipRefund(undefined,refundInput())),'recalculate');
    ok(await a.as('manager',()=>refunds.submitRefundToRegional(undefined,form({refundId}))),'submit');
    for(const role of ['owner','accountant','manager']) denied(await a.as(role,()=>refunds.approveRefundByRegional(undefined,form({refundId}))),role);
    ok(await a.as('regional_director',()=>refunds.returnRefundForCorrection(undefined,form({refundId,comment:'Уточните вымышленный договор'}))),'return correction');
    ok(await a.as('manager',()=>refunds.calculateMembershipRefund(undefined,refundInput())),'correct');
    ok(await a.as('manager',()=>refunds.submitRefundToRegional(undefined,form({refundId}))),'resubmit');
  });
  await check('REFUND approval recognizes cost once; accounting settles without Expense duplicate', async () => {
    const before=(await recognized(a)).totalKopeks;
    ok(await a.as('regional_director',()=>refunds.approveRefundByRegional(undefined,form({refundId}))),'approve refund');
    assert.equal((await recognized(a)).totalKopeks,before+refundAmount);
    const le=await db.legalEntity.findFirst({where:{companyId:a.companyId,type:'ooo',clubs:{some:{clubId:a.clubs[0]}}}});
    const payload={refundId,legalEntityId:le.id,paidAt:'2026-11-15',paymentComment:'Синтетическое проведение — реальной отправки нет'};
    for(const role of ['owner','manager']) denied(await a.as(role,()=>refunds.payRefundV2(undefined,form(payload))),role);
    denied(await b.as('accountant',()=>refunds.payRefundV2(undefined,form(payload))),'foreign refund pay');
    const expensesBefore=await db.expense.count({where:{companyId:a.companyId}});
    ok(await a.as('accountant',()=>refunds.payRefundV2(undefined,form(payload))),'pay refund');
    denied(await a.as('accountant',()=>refunds.payRefundV2(undefined,form(payload))),'double refund pay');
    assert.equal((await db.refund.findUnique({where:{id:refundId}})).status,'paid');assert.equal((await recognized(a)).totalKopeks,before+refundAmount);
    assert.equal(await db.expense.count({where:{companyId:a.companyId}}),expensesBefore);
    assert.equal(await computeUsedKopeks(a.clubs[0],'refunds','2026-11'),refundAmount);
    const profit=await calculateProfit({companyId:a.companyId,allowedClubIds:a.clubs,months:['2026-11']});
    assert.equal(profit.revenueKopeks,420_000_000);assert.equal(profit.profitKopeks,420_000_000-before-refundAmount);
    // Payment in another month must not shift the already recognized November cost.
    await db.refund.update({where:{id:refundId},data:{paidAt:new Date('2026-12-01T12:00:00Z')}});
    assert.equal((await recognized(a)).totalKopeks,before+refundAmount);
  });
  await check('ISOLATION independent visitor B keeps original figures after every A mutation',async()=>{
    assert.equal((await recognized(b)).totalKopeks,168_000_000);assert.equal(await db.payrollPayment.count({where:{companyId:b.companyId}}),0);assert.equal(await db.payrollAdvance.count({where:{companyId:b.companyId}}),0);
  });
  await check('OUTBOUND zero real external calls across all workflows',async()=>assert.deepEqual(outbound,[]));
  await check('ISOLATION simultaneous visitors update only their own branch budgets',async()=>{
    const changes=await Promise.all([a.as('owner',()=>budgets.createOrUpdateBudget(undefined,form({clubId:a.clubs[0],category:'household',month:'2026-11',amount:'260000'}))), b.as('owner',()=>budgets.createOrUpdateBudget(undefined,form({clubId:b.clubs[0],category:'household',month:'2026-11',amount:'110000'})))]);
    changes.forEach(r=>ok(r,'concurrent independent plan'));
    assert.equal((await db.budget.findFirst({where:{clubId:a.clubs[0],category:'household'}})).limitAmountKopeks,26_000_000);
    assert.equal((await db.budget.findFirst({where:{clubId:b.clubs[0],category:'household'}})).limitAmountKopeks,11_000_000);
  });
  await check('RESET removes mutated salary/budget/refund tenant and invalidates ordinary sessions',async()=>{
    await db.$transaction(tx=>purgeDemoVisit(tx,a.visit),{timeout:60_000});visits.splice(visits.findIndex(v=>v.id===a.visit.id),1);
    assert.equal(await a.as('manager',getCurrentAccessContext),null);
    for(const model of ['payrollPayment','payrollAdvance','payrollAdvancePayment','expense','refund','refundDocument','budget','auditLog']) assert.equal(await db[model].count({where:{companyId:a.companyId}}),0,`orphan ${model}`);
    assert.equal(await db.company.count({where:{id:b.companyId}}),1);
    const fresh=await tenant();assert.equal((await recognized(fresh)).totalKopeks,168_000_000);assert.equal(await db.clubEmployee.count({where:{companyId:fresh.companyId}}),48);
  });
  assert.deepEqual(outbound,[]);
  mkdirSync('artifacts/demo-functional',{recursive:true});
  writeFileSync('artifacts/demo-functional/results.json',JSON.stringify({results,outbound},null,2));
  console.log(`${results.filter(r=>r.status==='passed').length} functional scenarios passed`);
} finally {
  globalThis.fetch=oldFetch;
  for (const v of visits) await db.$transaction(tx=>purgeDemoVisit(tx,v),{timeout:60_000});
  await db.$disconnect();
}
