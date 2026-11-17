// Broad screen/render audit. Finance mutations remain in the dedicated DB/E2E suites.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
process.loadEnvFile('.env.demo.local');
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const {origin}=require('jiti')(import.meta.url)('../src/lib/demo/config.ts').demoConfig();
const {PrismaClient}=await import('@prisma/client');const db=new PrismaClient();
const browser=await chromium.launch({headless:true,executablePath:process.env.DEMO_CHROMIUM_PATH||'/usr/bin/chromium'});
const inventory=JSON.parse(readFileSync('docs/demo/screen-inventory-2026-11-17.json'));
const screens=inventory.filter(i=>i.kind==='screen'&&i.file.includes('(app)'));
const contexts=[],rows=[],issues=[],errors=[],externals=[],accessibility=[],checks=[];
const out='artifacts/final-audit';mkdirSync(out,{recursive:true});
const axePath=process.env.DEMO_AXE_PATH;
const check=n=>{checks.push(n);console.log('PASS',n)};
const capture=new Set(['/dashboard','/analytics','/invoices','/payroll','/refunds','/budgets','/documents','/demo']);
const forbidden=/тренер|трениров|фитнес|абонемент|(?<![А-Яа-яA-Za-z])(?:ТЗ|ГП|ПТ)(?![А-Яа-яA-Za-z])/u;
async function selectRole(page,role,club='0'){await page.goto(origin+'/demo');await page.locator('[name="role"]').selectOption(role);await page.locator('[name="club"]').selectOption(club);await page.getByRole('button',{name:'Посмотреть демо',exact:true}).click();await page.waitForURL(role==='accountant'?'**/workspace':'**/dashboard?month=2026-11');await page.waitForLoadState('networkidle')}
try{
for(const [index,role] of ['owner','general_director','regional_director','manager','accountant'].entries()){
 const context=await browser.newContext({baseURL:origin,extraHTTPHeaders:{'x-forwarded-for':`198.51.100.${30+index}`},viewport:{width:1440,height:1000}});contexts.push(context);context.on('request',r=>{if(new URL(r.url()).origin!==origin)externals.push(r.url())});
 const page=await context.newPage();page.on('pageerror',e=>errors.push({role,message:e.message}));await selectRole(page,role);
 const companyId=(await context.cookies()).find(c=>c.name==='scope_company').value;
 const [club,employee,period,scheme,expense,invoice,refund]=await Promise.all(['club','clubEmployee','payrollPeriod','employeePayScheme','expense','invoice','refund'].map(m=>db[m].findFirst({where:{companyId},orderBy:{createdAt:'asc'}})));
 const calc=await db.payrollCalculation.findFirst({where:{payrollPeriodId:period.id}});
 const visit=await db.demoVisit.findUniqueOrThrow({where:{companyId}}),users=JSON.parse(visit.usersJson);
 const advance=await db.payrollAdvance.create({data:{companyId,clubId:club.id,employeeId:employee.id,periodYear:2026,periodMonth:11}});
 const request=await db.payrollChangeRequest.create({data:{companyId,clubId:club.id,employeeId:employee.id,payrollCalculationId:calc.id,requestType:'period_adjustment',fieldType:'one_time_bonus',proposedValueJson:'10000',reason:'Синтетическая заявка для QA',requestedById:users.regional_director}});
 const connection=await db.ofdConnection.findFirst({where:{companyId}});
 const cashier=await db.ofdCashierIdentity.create({data:{companyId,clubId:club.id,ofdConnectionId:connection.id,rawName:employee.fullName,normalizedName:employee.fullName.toLowerCase(),firstSeenAt:new Date('2026-11-01'),lastSeenAt:new Date('2026-11-15'),identityKey:companyId+':audit'}});
 const report=await db.salesReport.create({data:{companyId,clubId:club.id,reportDate:new Date('2026-11-15'),createdByUserId:users.manager}});
 const draft=await db.refund.create({data:{companyId,clubId:club.id,createdByUserId:users.manager,entryVersion:2,returnType:'membership',status:'draft',reason:'Синтетическая заявка для QA'}});

 function pathFor(route){let url=route;if(url.startsWith('/payroll/advances/'))url=url.replace('[id]',advance.id);else if(url.startsWith('/payroll/change-requests/'))url=url.replace('[id]',request.id);else if(url.startsWith('/payroll/ofd-cashiers/'))url=url.replace('[id]',cashier.id);else if(url.startsWith('/sales/reports/'))url=url.replace('[id]',report.id);else if(url.startsWith('/refunds/new/'))url=url.replace('[id]',draft.id);else if(url.startsWith('/payroll/periods/'))url=url.replace('[id]',period.id).replace('[calculationId]',calc.id);else if(url.startsWith('/payroll/employees/'))url=url.replace('[id]',employee.id);else if(url.startsWith('/payroll/schemes/'))url=url.replace('[id]',scheme.id);else if(url.startsWith('/expenses/'))url=url.replace('[id]',expense.id);else if(url.startsWith('/invoices/'))url=url.replace('[id]',invoice.id);else if(url.startsWith('/refunds/'))url=url.replace('[id]',refund.id);if(url.includes('['))return null;if(url==='/analytics/expenses')url+='?category=household&from=2026-11-01&to=2026-11-30';return url}
 const available=[];
 for(const s of screens){const url=pathFor(s.route);if(!url){rows.push({role,route:s.route,result:'not-tested-no-fixture'});continue}const response=await page.goto(url);const text=await page.locator('body').innerText();const actual=new URL(page.url()).pathname;let result;
 if(s.demoLimit.startsWith('Blocked')){result=response.status()===403?'blocked':'unexpected-demo-gate';}
 else if(text.includes('This page could not be found')||text.includes('404')&&response.status()===404){result='not-found';}
 else if(actual!==new URL(url,origin).pathname){result='redirect';}
 else if(response.status()>=400){result='http-error';}
 else if(!await page.locator('h1').count()){result='missing-heading';}
 else{result='rendered';available.push({s,url});assert.equal(await page.locator('aside[aria-label="Демонстрационная версия"]').count(),1);if(forbidden.test(s.route==='/payments'?text.replace(/ПТ/g,'Пятница'):text))issues.push({role,route:s.route,issue:'sector-term'});if(/Application error|Something went wrong|Что-то пошло не так/.test(text))issues.push({role,route:s.route,issue:'error-boundary'});}
 if(['http-error','missing-heading','unexpected-demo-gate'].includes(result))issues.push({role,route:s.route,issue:result});
 rows.push({role,route:s.route,url,result,status:response.status(),actual,heading:(await page.locator('h1').allTextContents()).join(';'),controls:await page.locator('main button,main input,main select').count()});
 }
 check(`${role}: ${available.length} rendered screens; guarded and missing-fixture routes recorded separately`);
 for(const theme of ['light','dark']){
  await page.addInitScript(value=>localStorage.setItem('theme',value),theme);
  for(const width of [375,390,768,1024,1440]){await page.setViewportSize({width,height:1000});for(const{s,url}of available){await page.goto(url,{waitUntil:'load'});await page.locator('h1').first().waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),theme);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);if(overflow)issues.push({role,route:s.route,theme,width,issue:'overflow'});
   if(capture.has(s.route)&&[375,1440].includes(width))await page.screenshot({path:`${out}/${role}-${s.route.replaceAll('/','_')}-${theme}-${width}.png`,fullPage:true});
   if(axePath&&width===1440&&capture.has(s.route)){await page.evaluate(readFileSync(axePath,'utf8'));const a=await page.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary})).slice(0,12)}))});if(a.length)accessibility.push({role,route:s.route,theme,violations:a});}
  }writeFileSync(`${out}/browser-audit.json`,JSON.stringify({checks,rows,issues,errors,externals,accessibility},null,2));check(`${role}: ${theme} ${width}px (${available.length} screens)`)}
 }
 // Existing native fallback must work without hydration.
 const nojs=await browser.newContext({baseURL:origin,javaScriptEnabled:false,storageState:await context.storageState(),viewport:{width:375,height:900}});const np=await nojs.newPage();await np.goto(role==='accountant'?'/workspace':'/dashboard');await np.locator('summary').filter({hasText:'Разделы'}).click();const link=np.locator('nav[aria-label="Все разделы CLUB OPS"] a').first();const href=await link.getAttribute('href');await link.click();assert.equal(new URL(np.url()).pathname,href);await nojs.close();check(`${role}: no-JavaScript native navigation`);
 if(role==='manager'){await selectRole(page,'manager','1');await page.goto('/demo');assert.equal(await page.locator('[name="role"]').inputValue(),'manager');assert.equal(await page.locator('[name="club"]').inputValue(),'1');const grants=await db.clubUserAccess.findMany({where:{userId:JSON.parse((await db.demoVisit.findUnique({where:{companyId}})).usersJson).manager}});assert.equal(grants.length,1);check('Manager branch and role survive return to demo form');}
 await page.setViewportSize({width:375,height:1000});await page.goto(role==='accountant'?'/workspace':'/dashboard');await page.getByRole('button',{name:'Меню',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Закрыть');await page.keyboard.press('Shift+Tab');assert(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement)));await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);await page.getByRole('button',{name:'Меню',exact:true}).evaluate(el=>{if(document.activeElement!==el)throw Error('Focus was not restored')});check(`${role}: mobile drawer keyboard focus, Tab containment and Escape`);
 if(role==='owner'){await page.setViewportSize({width:1440,height:1000});await page.goto('/analytics/ofd-sales');await page.waitForLoadState('networkidle');assert.equal(await page.locator('aside nav a[aria-current="page"]').count(),1);await page.goto('/budgets');await page.waitForLoadState('networkidle');await page.goBack();await page.waitForURL('**/analytics/ofd-sales*');assert.equal(new URL(page.url()).pathname,'/analytics/ofd-sales');check('Desktop active route is unique; browser Back preserves section');}
 const invalid=await page.evaluate(async()=>{const r=await fetch('/api/demo/session',{method:'POST',body:new URLSearchParams({role:'system_admin',club:'0'})});return r.status});assert.equal(invalid,400);check(`${role}: forged role rejected`);
}
assert.deepEqual(externals,[]);assert.deepEqual(errors,[]);check('No external browser requests or uncaught JS errors');
}finally{
writeFileSync(`${out}/browser-audit.json`,JSON.stringify({checks,rows,issues,errors,externals,accessibility},null,2));
for(const c of contexts){const companyId=(await c.cookies()).find(x=>x.name==='scope_company')?.value;if(companyId)await db.demoVisit.updateMany({where:{companyId},data:{expiresAt:new Date(0)}});await c.close()}
await fetch(origin+'/api/demo/cleanup',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${process.env.DEMO_CLEANUP_SECRET}`}}).catch(()=>{});await browser.close();await db.$disconnect();
}
console.log(JSON.stringify({checks:checks.length,screenRoleRows:rows.length,issues:issues.length,accessibilityScreens:accessibility.length}));assert.deepEqual(issues,[]);
