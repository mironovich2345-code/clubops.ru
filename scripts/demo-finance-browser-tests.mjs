import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
process.loadEnvFile('.env.demo.local');
const require=createRequire(import.meta.url);
const {demoConfig}=require('jiti')(import.meta.url)('../src/lib/demo/config.ts');
const {origin}=demoConfig();
const {PrismaClient}=await import('@prisma/client');
const db=new PrismaClient();
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,...(process.env.DEMO_CHROMIUM_PATH?{executablePath:process.env.DEMO_CHROMIUM_PATH}:{})});
const contexts=[], failures=[], externals=[], results=[];
mkdirSync('artifacts/demo-finance',{recursive:true});
const pass=name=>{results.push(name);console.log(`PASS ${name}`);};
async function poll(fn,message){for(let i=0;i<80;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error(message);}
async function visitor(ip){const context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000},extraHTTPHeaders:{'x-forwarded-for':ip}});contexts.push(context);context.on('request',r=>{if(new URL(r.url()).origin!==origin)externals.push(r.url());});const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));page.on('dialog',d=>d.accept());await page.goto('/demo');await page.getByRole('button',{name:'Посмотреть демо',exact:true}).click();await page.waitForURL('**/dashboard?month=2026-11');await page.locator('h1').waitFor();return{page,context,companyId:(await context.cookies()).find(c=>c.name==='scope_company').value};}
async function role(page,value){await page.goto('/demo');await page.locator('select[name="role"]').selectOption(value);await page.getByRole('button',{name:'Посмотреть демо',exact:true}).click();await page.waitForURL(value==='accountant'?'**/workspace':'**/dashboard?month=2026-11');await page.waitForLoadState('networkidle');}
try{
 const ip=20+(process.pid%100)*2;
 const a=await visitor(`192.0.2.${ip}`),b=await visitor(`192.0.2.${ip+1}`);
 const club=await db.club.findFirst({where:{companyId:a.companyId,name:'Центральный'}});
 const period=await db.payrollPeriod.findFirst({where:{companyId:a.companyId,clubId:club.id}});
 const calc=await db.payrollCalculation.findFirst({where:{payrollPeriodId:period.id},orderBy:{createdAt:'asc'}});
 await a.page.goto(`/budgets?clubId=${club.id}&month=2026-11`);
 const budgetForm=a.page.getByRole('button',{name:'Сохранить лимит',exact:true}).locator('xpath=ancestor::form');
 await budgetForm.locator('[name="category"]').selectOption('household');await budgetForm.locator('[name="amount"]').fill('250000');await budgetForm.getByRole('button',{name:'Сохранить лимит',exact:true}).click();
 await a.page.getByText('Лимит сохранён',{exact:true}).waitFor();assert.equal((await db.budget.findFirst({where:{clubId:club.id,category:'household'}})).limitAmountKopeks,25_000_000);pass('Owner edits branch budget through original UI');
 await role(a.page,'manager');await a.page.goto(`/payroll/periods/${period.id}/employees/${calc.id}`);
 await a.page.locator('[name="actualShifts"]').fill('10');await a.page.getByRole('button',{name:'Рассчитать',exact:true}).click();
 await poll(async()=> (await db.payrollCalculation.findUnique({where:{id:calc.id}})).automaticAmountKopeks===2_000_000,'calculation was not persisted');pass('Branch manager recalculates employee salary through original UI');
 await a.page.goto('/expenses/simple');await a.page.locator('[name="category"]').selectOption('household');await a.page.locator('[name="amount"]').fill('1000');await a.page.locator('[name="expenseDate"]').fill('2026-11-15');await a.page.locator('[name="comment"]').fill('Демо QA — материалы филиала');await a.page.getByRole('button',{name:'Создать расход',exact:true}).filter({visible:true}).click();
 await a.page.waitForURL(url=>/^\/expenses\/c[a-z0-9]{15,}$/.test(url.pathname));const expenseId=new URL(a.page.url()).pathname.split('/').pop();assert.equal((await db.expense.findUnique({where:{id:expenseId}})).status,'pending_regional_budget_approval');assert.equal(await db.expenseDocument.count({where:{expenseId}}),1);pass('Manager creates and submits expense with generated synthetic PDF, no upload');
 await a.page.goto('/refunds/new');await a.page.getByRole('button',{name:'Создать черновик',exact:true}).click();await a.page.waitForURL(/\/refunds\/new\/[a-z0-9]+$/);const refundId=new URL(a.page.url()).pathname.split('/').pop();
 await a.page.getByRole('button',{name:'Заполнить синтетический комплект',exact:true}).click();await a.page.getByRole('status').getByText('Синтетический комплект готов').waitFor();assert.equal(await db.refundDocument.count({where:{refundId}}),4);
 await a.page.getByRole('button',{name:'Далее',exact:true}).filter({visible:true}).click();await a.page.waitForURL('**/details');
 for(const[name,value]of Object.entries({serviceStartDate:'2026-11-01',serviceEndDate:'2026-11-30',applicationDate:'2026-11-15',contractAmount:'30000'}))await a.page.locator(`[name="${name}"]`).fill(value);
 await a.page.getByRole('button',{name:'Рассчитать',exact:true}).click();await poll(async()=>Boolean((await db.refund.findUnique({where:{id:refundId}})).calculationVersion),'refund was not calculated');
 await a.page.getByRole('button',{name:'Создать возврат',exact:true}).click();await a.page.waitForURL(/\/refunds\/[a-z0-9]+\?submitted=1/);pass('Manager creates, documents, calculates and submits v2 refund in browser');
 await role(a.page,'regional_director');await a.page.goto(`/refunds/${refundId}`);await a.page.getByRole('button',{name:'Согласовать',exact:true}).click();await poll(async()=> (await db.refund.findUnique({where:{id:refundId}})).status==='accounting_in_progress','refund not approved');pass('Regional reviews and hands refund to accounting in browser');
 await role(a.page,'accountant');await a.page.goto(`/refunds/${refundId}`);const le=await db.legalEntity.findFirst({where:{companyId:a.companyId,type:'ooo',clubs:{some:{clubId:club.id}}}});await a.page.locator('[name="legalEntityId"]').selectOption(le.id);await a.page.locator('[name="paidAt"]').fill('2026-11-15');await a.page.getByRole('button',{name:'Оплачено',exact:true}).click();await poll(async()=> (await db.refund.findUnique({where:{id:refundId}})).status==='paid','refund not paid');pass('Accountant settles approved refund in original UI without a real transfer');
 for(const width of[375,1440]){await a.page.setViewportSize({width,height:1000});await a.page.goto(`/refunds/${refundId}`);assert.equal(await a.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);await a.page.screenshot({path:`artifacts/demo-finance/refund-paid-${width}.png`,fullPage:true});}pass('Changed refund screens remain responsive at 375 and 1440');
 await a.page.goto('/demo');await Promise.all([a.page.waitForResponse(r=>r.url().endsWith('/api/demo/session')&&r.request().method()==='POST'),a.page.getByRole('button',{name:'Сбросить данные и начать заново',exact:true}).click()]);await a.page.waitForLoadState('networkidle');assert.equal(await db.company.count({where:{id:a.companyId}}),0);assert.equal(await db.company.count({where:{id:b.companyId}}),1);for(const model of['payrollCalculation','refund','refundDocument','expense','budget'])assert.equal(await db[model].count({where:{companyId:a.companyId}}),0);pass('Actual reset button removes all mutated A finance rows, visitor B remains intact');
 assert.deepEqual(externals,[]);assert.deepEqual(failures,[]);pass('No external browser requests or JavaScript errors');
 writeFileSync('artifacts/demo-finance/results.json',JSON.stringify({passed:results,externals,failures},null,2));console.log(`${results.length} finance browser scenarios passed`);
}catch(e){for(const [i,c] of contexts.entries()){const p=c.pages()[0];if(p){await p.screenshot({path:`artifacts/demo-finance/failure-${i}.png`,fullPage:true}).catch(()=>{});console.error("Failed page",i,new URL(p.url()).pathname);}}throw e;
}finally{for(const c of contexts){const companyId=(await c.cookies()).find(v=>v.name==='scope_company')?.value;if(companyId)await db.demoVisit.updateMany({where:{companyId},data:{expiresAt:new Date(0)}});}await fetch(`${origin}/api/demo/cleanup`,{method:'POST',headers:{Authorization:`Bearer ${process.env.DEMO_CLEANUP_SECRET}`,Origin:origin}}).catch(()=>{});for(const c of contexts)await c.close();await browser.close();await db.$disconnect();}
