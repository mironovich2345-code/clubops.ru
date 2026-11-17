import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),ts=require('typescript'),jiti=require('jiti')(import.meta.url,{alias:{'@':process.cwd()+'/src'}});
const {PLAN_TEMPLATE_HEADER,buildPlanTemplateBuffer,parsePlanSheet}=jiti('../src/lib/imports/plan-import.ts');
const {describeParamRows}=jiti('../src/lib/payroll/scheme-version.ts');
const {allowedFieldsForScheme}=jiti('../src/lib/payroll/change-request.ts');
const forbidden=/тренер|трениров|фитнес|абонемент|(?<![А-Яа-яA-Za-z])(?:ТЗ|ГП|ПТ|PT)(?![А-Яа-яA-Za-z])/iu;
assert(!forbidden.test(PLAN_TEMPLATE_HEADER.join(' ')));
const XLSX=require('xlsx');
const canonical=buildPlanTemplateBuffer('2026-11',[{id:'demo-branch',name:'Демо Филиал',city:'Демоград'}]);
assert.deepEqual(parsePlanSheet(canonical).missing,[]);
const legacy=XLSX.utils.book_new();
XLSX.utils.book_append_sheet(legacy,XLSX.utils.aoa_to_sheet([['clubId','Клуб','Город','Месяц','План АБ','План ПТ'],['demo-branch','Демо Филиал','Демоград','2026-11',1000,2000]]),'Plan');
const legacyParsed=parsePlanSheet(XLSX.write(legacy,{type:'buffer',bookType:'xlsx'}));
assert.deepEqual(legacyParsed.missing,[]);
assert.equal(legacyParsed.rows[0].subsCell,1000);
assert.equal(legacyParsed.rows[0].ptCell,2000);
for(const type of ['plan_adjusted_salary','revenue_percentage','role_club_manager','role_gym_trainer'])assert(allowedFieldsForScheme(type).every(f=>!forbidden.test(f.labelRu)),type);
assert(describeParamRows({abBaseKopeks:100,ptBaseKopeks:200,subsPercentBp:100}).every(f=>!forbidden.test(f.label)));
// Legacy input vocabulary is retained only for parsing/classification, never as a generated template.
const exceptions=new Set(['src/lib/ofd/revenue.ts','src/lib/imports/plan-import.ts']);
const findings=[];
for(const p of execFileSync('rg',['--files','src'],{encoding:'utf8'}).trim().split('\n').filter(p=>/\.tsx?$/.test(p)&&!p.endsWith('.test.ts')&&!exceptions.has(p))){const sf=ts.createSourceFile(p,readFileSync(p,'utf8'),99,true);function walk(n){if((ts.isStringLiteral(n)||ts.isJsxText(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateHead(n)||ts.isTemplateMiddle(n)||ts.isTemplateTail(n))&&(/[А-Яа-я]/.test(n.text)||n.text==='PT')&&!['Пт','пт'].includes(n.text)&&forbidden.test(n.text))findings.push({p,text:n.text});ts.forEachChild(n,walk)}walk(sf)}
assert.deepEqual(findings,[]);console.log('PASS generated template, payroll labels and application presentation literals are sector-neutral');
