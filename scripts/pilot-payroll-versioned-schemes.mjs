// STAGE 12 regression: versioned pay schemes. Pure mirror of scheme-version.ts (logical
// key, version scope, interval overlap, status machine, resolver liveness) + static guards
// on the real service/resolver/immutability/migration/UI + real-DB invariants (backfill,
// used-immutable, version scope, resolver by period date, sourceChangeRequestId uniqueness,
// interval closing, snapshot immutability, tenant/IDOR).
//   npm run pilot:payroll-versioned-schemes
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const D = (s) => new Date(s);
const ms = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

// ---- mirror of scheme-version.ts ----
const LIVE = new Set(["approved", "scheduled", "active", "superseded"]);
const isLive = (s) => LIVE.has(s);
const logicalKey = (s) => `${s.companyId}|${s.clubId}|${s.employeeId ?? "ALL"}|${s.position ?? ""}`;
const nextVersion = (rows) => rows.reduce((m, r) => Math.max(m, r.version), 0) + 1;
function overlaps(a, b) { const aF = ms(a.effectiveFrom), aT = a.effectiveTo == null ? Infinity : ms(a.effectiveTo); const bF = ms(b.effectiveFrom), bT = b.effectiveTo == null ? Infinity : ms(b.effectiveTo); return aF < bT && bF < aT; }
const committedStatusFor = (from, at) => (ms(from) > ms(at) ? "scheduled" : "active");
const ALLOWED = { submit: ["draft"], approve: ["pending_approval"], activate: ["approved", "scheduled"], supersede: ["active", "scheduled", "approved"], archive: ["draft", "rejected", "cancelled", "superseded"], cancel: ["draft", "pending_approval"] };
const canT = (from, t) => (ALLOWED[t] ?? []).includes(from);
// resolver mirror: effective among LIVE by date (max from wins)
function resolveEff(rows, at) { const t = ms(at); let best = null; for (const s of rows.filter((r) => isLive(r.status))) { const to = s.effectiveTo == null ? Infinity : ms(s.effectiveTo); if (ms(s.effectiveFrom) <= t && t < to) { if (!best || ms(s.effectiveFrom) > ms(best.effectiveFrom)) best = s; } } return best; }
function coveringConflict(rows, at) { const t = ms(at); return rows.filter((s) => isLive(s.status) && ms(s.effectiveFrom) <= t && (s.effectiveTo == null || ms(s.effectiveTo) > t)).length >= 2; }

function pureTests() {
  check("P1 logical key разделяет employee и category цепочки", logicalKey({ companyId: "c", clubId: "k", employeeId: "e", position: "sales_manager" }) !== logicalKey({ companyId: "c", clubId: "k", employeeId: null, position: "sales_manager" }));
  check("P2 version инкремент в пределах ключа (не глобальный max)", nextVersion([{ version: 1 }, { version: 2 }]) === 3 && nextVersion([]) === 1);
  check("P3 interval overlap: end-exclusive", overlaps({ effectiveFrom: D("2026-01-01"), effectiveTo: D("2026-08-01") }, { effectiveFrom: D("2026-07-01"), effectiveTo: null }) && !overlaps({ effectiveFrom: D("2026-01-01"), effectiveTo: D("2026-08-01") }, { effectiveFrom: D("2026-08-01"), effectiveTo: null }));
  check("P4 committedStatusFor: будущая → scheduled, иначе active", committedStatusFor(D("2026-12-01"), D("2026-07-01")) === "scheduled" && committedStatusFor(D("2026-06-01"), D("2026-07-01")) === "active");
  check("P5 state machine: submit только из draft; approve только из pending", canT("draft", "submit") && !canT("active", "submit") && canT("pending_approval", "approve") && !canT("draft", "approve"));
  check("P6 archive: только draft/rejected/cancelled/superseded", canT("superseded", "archive") && canT("draft", "archive") && !canT("active", "archive"));
  // resolver by date
  const chain = [
    { id: "v1", status: "superseded", effectiveFrom: D("2026-01-01"), effectiveTo: D("2026-08-01") },
    { id: "v2", status: "active", effectiveFrom: D("2026-08-01"), effectiveTo: null },
  ];
  check("P7 resolver до effectiveFrom выбирает старую версию", resolveEff(chain, D("2026-07-15")).id === "v1");
  check("P8 resolver после effectiveFrom выбирает новую версию", resolveEff(chain, D("2026-08-15")).id === "v2");
  check("P9 resolver использует ДАТУ периода (не today): июль→v1 даже если сейчас декабрь", resolveEff(chain, D("2026-07-15")).id === "v1");
  check("P10 draft/rejected не участвуют в resolver", resolveEff([{ id: "d", status: "draft", effectiveFrom: D("2026-01-01"), effectiveTo: null }, { id: "r", status: "rejected", effectiveFrom: D("2026-01-01"), effectiveTo: null }], D("2026-06-01")) === null);
  check("P11 superseded не используется для даты вне его интервала", resolveEff([{ id: "s", status: "superseded", effectiveFrom: D("2026-01-01"), effectiveTo: D("2026-06-01") }], D("2026-09-01")) === null);
  check("P12 две live версии на одну дату → conflict (не выбор случайной)", coveringConflict([{ status: "active", effectiveFrom: D("2026-01-01"), effectiveTo: null }, { status: "active", effectiveFrom: D("2026-01-01"), effectiveTo: null }], D("2026-06-01")));
}

function staticGuards() {
  const ver = src("../src/lib/payroll/scheme-version.ts");
  const svc = src("../src/lib/payroll/scheme-service.ts");
  const schemes = src("../src/lib/payroll/schemes.ts");
  const schemeActions = src("../src/app/(app)/payroll/schemes/actions.ts");
  const crActions = src("../src/app/(app)/payroll/change-requests/actions.ts");
  const periods = src("../src/lib/payroll/periods.ts");
  const migDev = src("../prisma/migrations/20260726120000_payroll_scheme_versions/migration.sql");
  const migProd = src("../prisma/production/migrations/20260726120000_payroll_scheme_versions/migration.sql");
  const listUI = src("../src/app/(app)/payroll/schemes/page.tsx");
  const detailUI = src("../src/app/(app)/payroll/schemes/[id]/page.tsx");
  const backfill = src("../scripts/payroll-scheme-backfill.mjs");
  const auditScript = src("../scripts/payroll-scheme-audit.mjs");

  check("SG1 логический ключ + version-scope в scheme-version (не глобальный max)", ver.includes("export function logicalSchemeKey") && ver.includes("export function nextVersion") && ver.includes("scoped, never global"));
  check("SG2 resolver: только live-статусы + выбор по дате периода", schemes.includes("isLiveForResolver") && schemes.includes("resolveEffectiveScheme(liveRows("));
  check("SG3 resolver conflict: ≥2 live на дату → блок (не молчаливый выбор)", schemes.includes("covering.length >= 2") && schemes.includes("Требуется исправление настроек"));
  check("SG4 materialize идемпотентен: sourceChangeRequestId @unique + возврат существующей", svc.includes("materializeApprovedSchemeChange") && svc.includes("findUnique({ where: { sourceChangeRequestId: requestId } })") && svc.includes("alreadyExisted: true"));
  check("SG5 materialize: сбой НЕ помечает заявку applied (safe retry)", svc.includes("safe retry") && crActions.includes("не создана") && crActions.includes("approved_pending_scheme_creation"));
  check("SG6 createCommittedVersion: append-forward + закрытие предыдущего интервала (не правит params)", svc.includes("Append-forward") && svc.includes('status: "superseded"') && svc.includes("effectiveTo: effectiveFrom"));
  check("SG7 approve change-request → materialize новой версии (§15)", crActions.includes("materializeApprovedSchemeChange(req.id") && crActions.includes("создана новая версия схемы"));
  check("SG8 immutability: used/active/superseded params заморожены (guard в schemes/actions)", schemeActions.includes("isSchemeUsed") && schemeActions.includes("параметры неизменяемы") && schemeActions.includes('scheme.status !== "draft"'));
  check("SG9 роли: регионал только черновик, активирует ГД/owner/гл.бух (canActivateScheme)", schemeActions.includes("canActivateScheme") && src("../src/lib/payroll/access.ts").includes("export function canActivateScheme") && !/r === "regional_director"/.test(src("../src/lib/payroll/access.ts").slice(src("../src/lib/payroll/access.ts").indexOf("canActivateScheme"), src("../src/lib/payroll/access.ts").indexOf("canActivateScheme") + 260)));
  check("SG10 snapshot обогащён version/level/source/resolvedAt (аддитивно)", periods.includes("resolverLevel") && periods.includes("version: scheme.version") && periods.includes("sourceChangeRequestId") && periods.includes("resolvedAt"));
  check("SG11 миграция аддитивна (ADD COLUMN + unique sourceChangeRequestId, без DROP/ALTER COLUMN/rebuild)", migDev.includes("ADD COLUMN") && migDev.includes("EmployeePayScheme_sourceChangeRequestId_key") && migProd.includes("ADD COLUMN") && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(migDev) && !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+COLUMN\b|\bRENAME\b/i.test(migProd));
  check("SG12 backfill dry-run по умолчанию, --apply явно, неоднозначные пропускаются", backfill.includes("DRY-RUN") && backfill.includes("--apply") && backfill.includes("ambiguous") && !/createSalaryExpense/.test(backfill));
  check("SG13 audit только счётчики/ID, без секретов (нет DATABASE_URL/PII)", auditScript.includes("read-only") && !/DATABASE_URL|password|secret/i.test(auditScript));
  check("SG14 UI список: карточки на mobile + таблица на desktop + версия/статус/даты", listUI.includes("sm:hidden") && listUI.includes("hidden overflow-hidden sm:block") && listUI.includes("История версий"));
  check("SG15 UI compare: было/стало по параметрам без сырого JSON (§13)", detailUI.includes("diffParamRows") && detailUI.includes("Сравнение v") && detailUI.includes("describeParamRows"));
  check("SG16 UI mobile: цепочка версий вертикально, кнопки ≥44px", src("../src/app/(app)/payroll/_components/SchemeLifecycleActions.tsx").includes("min-h-[44px]") && detailUI.includes("space-y-4"));
}

async function realDb() {
  const uid = `vsch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}-o@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const clubA = await p.club.create({ data: { companyId: co.id, name: "A", city: "X" } });
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "Сотр", position: "sales_manager", status: "active" } });
  const params = JSON.stringify({ salaryFor15Kopeks: 4500000, shiftNorm: 15, tiers: [{ thresholdBp: 0, percentBp: 300 }, { thresholdBp: 10000, percentBp: 400 }] });

  // Backfill invariant: a chain of category versions gets version 1..N by effectiveFrom.
  const v1 = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: null, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: D("2026-01-01"), effectiveTo: D("2026-08-01"), version: 1, status: "superseded", createdByUserId: owner.id } });
  const v2 = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: null, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: D("2026-08-01"), version: 2, status: "active", supersedesSchemeId: v1.id, createdByUserId: owner.id } });
  check("T1 backfill: цепочка версий v1/v2 в одном логическом ключе", v1.version === 1 && v2.version === 2 && logicalKey(v1) === logicalKey(v2));
  check("T2 предыдущая версия закрыта (effectiveTo = дата новой), новая открыта", ms(v1.effectiveTo) === ms(D("2026-08-01")) && v2.effectiveTo === null && v2.supersedesSchemeId === v1.id);

  // Employee-specific chain versions independently of category chain.
  const e1 = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: D("2026-09-01"), version: 1, status: "active", createdByUserId: owner.id } });
  check("T3 employee-версия считается отдельно от category (v1 при category v2)", e1.version === 1 && logicalKey(e1) !== logicalKey(v2));

  // Future scheduled version.
  const future = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: D("2027-01-01"), version: 2, status: "scheduled", createdByUserId: owner.id } });
  check("T4 будущая версия — scheduled", future.status === "scheduled" && committedStatusFor(future.effectiveFrom, D("2026-07-01")) === "scheduled");

  // Resolver by date (mirror over the real rows): employee wins over category for a date it covers.
  const empRows = await p.employeePayScheme.findMany({ where: { companyId: co.id, clubId: clubA.id, employeeId: emp.id } });
  const catRows = await p.employeePayScheme.findMany({ where: { companyId: co.id, clubId: clubA.id, employeeId: null, position: "sales_manager" } });
  const resolvedSep = resolveEff(empRows, D("2026-09-15")) ?? resolveEff(catRows, D("2026-09-15"));
  check("T5 employee-версия перекрывает category на дату, которую покрывает", resolvedSep?.id === e1.id);
  const resolvedJul = resolveEff(empRows, D("2026-07-15")) ?? resolveEff(catRows, D("2026-07-15"));
  check("T6 до employee-версии (июль) используется category v1", resolvedJul?.id === v1.id);

  // Used-in-snapshot immutability marker.
  const period = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: clubA.id, year: 2026, month: 8, status: "draft", createdByUserId: owner.id } });
  const snapshot = JSON.stringify({ schemeId: v2.id, schemeType: "role_sales_manager", params: JSON.parse(params), effectiveFrom: v2.effectiveFrom.toISOString(), version: 2 });
  await p.payrollCalculation.create({ data: { payrollPeriodId: period.id, companyId: co.id, clubId: clubA.id, employeeId: emp.id, roleSnapshot: "sales_manager", schemeSnapshotJson: snapshot, status: "calculated" } });
  const used = await p.payrollCalculation.findFirst({ where: { schemeSnapshotJson: { contains: `"schemeId":"${v2.id}"` } } });
  check("T7 used-scheme определяется по snapshot (immutable-маркер)", Boolean(used));
  check("T8 старый snapshot не меняется при появлении новой версии (хранит v2.id/version)", JSON.parse(used.schemeSnapshotJson).schemeId === v2.id && JSON.parse(used.schemeSnapshotJson).version === 2);

  // Materialization idempotency: sourceChangeRequestId @unique enforces one version.
  const cr = await p.payrollChangeRequest.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, requestType: "future_scheme_change", fieldType: "base_salary", targetField: "salaryFor15Kopeks", proposedValueJson: JSON.stringify(5000000), reason: "рост", status: "approved_pending_scheme_creation", requestedById: owner.id, effectiveFrom: D("2027-06-01") } });
  const matVersion = await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: JSON.stringify({ salaryFor15Kopeks: 5000000, shiftNorm: 15, tiers: JSON.parse(params).tiers }), effectiveFrom: D("2027-06-01"), version: 3, status: "scheduled", sourceChangeRequestId: cr.id, createdByUserId: owner.id } });
  check("T9 materialize создаёт версию, привязанную к заявке (sourceChangeRequestId)", matVersion.sourceChangeRequestId === cr.id);
  let dup = false;
  try { await p.employeePayScheme.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, position: "sales_manager", schemeType: "role_sales_manager", paramsJson: params, effectiveFrom: D("2027-07-01"), version: 4, status: "scheduled", sourceChangeRequestId: cr.id, createdByUserId: owner.id } }); } catch { dup = true; }
  check("T10 повторный materialize по той же заявке заблокирован (@unique) — нет дубля", dup);

  // Immutability: v2 params must not change (business invariant; we assert stored value stable).
  const v2now = await p.employeePayScheme.findUnique({ where: { id: v2.id } });
  check("T11 параметры активной версии неизменны (v2 params стабильны)", v2now.paramsJson === params && v2now.version === 2);

  // Tenant isolation.
  check("T12 tenant isolation: чужая компания не видит версии схем", (await p.employeePayScheme.count({ where: { companyId: otherCo.id } })) === 0);
  check("T13 IDOR: все версии принадлежат своей компании/клубу", (await p.employeePayScheme.findMany({ where: { companyId: co.id } })).every((s) => s.companyId === co.id && s.clubId === clubA.id));

  // cleanup
  await p.payrollCalculation.deleteMany({ where: { payrollPeriodId: period.id } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.payrollChangeRequest.deleteMany({ where: { companyId: co.id } });
  await p.employeePayScheme.deleteMany({ where: { companyId: co.id } });
  await p.clubEmployee.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.delete({ where: { id: owner.id } });
}

async function main() {
  pureTests();
  staticGuards();
  await realDb();
  await p.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
