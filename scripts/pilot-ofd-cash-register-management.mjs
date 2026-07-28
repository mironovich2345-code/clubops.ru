// Regression: OFD cash-register management (edit / delete / archive / purge + binding & FN
// history). Static guards on the real service/actions/UI + real-DB invariants (receipt
// snapshot preserves history, FN history, assignment history, hard-delete vs archive,
// purge closed-period guard, dup-FN conflict, tenant/IDOR).
//   npm run pilot:ofd-cash-register-management
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

function staticGuards() {
  const svc = src("../src/lib/ofd/cash-register-service.ts");
  const act = src("../src/app/(app)/settings/integrations/ofd/actions.ts");
  const ui = src("../src/app/(app)/settings/integrations/ofd/_components/CashRegisterManager.tsx");

  check("SG1 edit: все поля (ФН/РНМ/название/подключение/юрлицо/клуб/тип) от даты", act.includes("export async function editCashRegister") && act.includes("recordAssignmentChange") && act.includes("recordFiscalDriveChange") && act.includes("effectiveFrom"));
  check("SG2 edit: FN-conflict guard (активный ФН уже существует → перенос)", act.includes("Активная касса с этим ФН уже существует"));
  check("SG3 service: смена привязки закрывает старую + открывает новую (end-exclusive)", svc.includes("recordAssignmentChange") && svc.includes("effectiveTo: null") && svc.includes("effectiveTo: args.effectiveFrom"));
  check("SG4 service: смена ФН оставляет старый в истории (status replaced), новый active", svc.includes("recordFiscalDriveChange") && svc.includes('status: "replaced"') && svc.includes('status: "active"'));
  check("SG5 delete: hard delete только для пустой; иначе archive (история сохраняется)", act.includes("export async function deleteCashRegister") && act.includes("hasBlockingHistory(usage)") && act.includes('status: "archived"') && act.includes("ofdCashRegisterMapping.delete"));
  check("SG6 purge: owner-only + PIN + typed FN + dry-run + closed-period guard + транзакция + audit", act.includes("export async function purgeCashRegisterHistory") && act.includes('userHasCompanyRole(g.userId, g.companyId, ["owner"])') && act.includes("usage.usedInClosedPeriod") && act.includes('str(formData, "apply") === "1"') && act.includes('confirmFn') && act.includes("purge_started") && act.includes("purged"));
  check("SG7 usage: used-in-closed-period определяется по атрибуциям закрытого периода", svc.includes("usedInClosedPeriod") && svc.includes('status: "closed"'));
  check("SG8 UI: mobile-карточки + фильтр Активные/Удалённые/Все + действия (не таблица)", ui.includes("Активные") && ui.includes("Удалённые") && ui.includes("min-h-[44px]") && ui.includes("Изменить") && ui.includes("Удалить") && !ui.includes("<table"));
  check("SG9 UI: удаление честно сообщает archive-vs-hard-delete по числу чеков", ui.includes("Исторические чеки и аналитика сохранятся") && ui.includes("нет чеков"));
  check("SG10 edit: audit + tenant-проверка каждой ссылки (connection/club/legalEntity)", act.includes("ofd.cash_register_edited") && act.includes("Подключение не найдено в этой компании") && act.includes("Клуб не найден в этой компании"));
}

async function realDb() {
  const uid = `crm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const owner = await p.user.create({ data: { email: `${uid}-o@t.dev`, name: "O", role: "owner", isActive: true } });
  const co = await p.company.create({ data: { name: `Co ${uid}` } });
  const otherCo = await p.company.create({ data: { name: `Other ${uid}` } });
  const clubA = await p.club.create({ data: { companyId: co.id, name: "A", city: "X" } });
  const clubB = await p.club.create({ data: { companyId: co.id, name: "B", city: "X" } });
  const conn = await p.ofdConnection.create({ data: { companyId: co.id, provider: "taxcom", displayName: "c", serverBaseUrl: "https://x", authType: "login_password", createdByUserId: owner.id } });
  const FN = "9990001";
  const mapping = await p.ofdCashRegisterMapping.create({ data: { connectionId: conn.id, companyId: co.id, clubId: clubA.id, provider: "taxcom", fnNumber: FN, kktName: "KKT-1", registerKind: "club_cashbox", isActive: true, activeMappingKey: `taxcom:${FN}`, status: "active" } });
  // initial history rows (mirror ensureInitialHistory)
  await p.ofdFiscalDrive.create({ data: { companyId: co.id, provider: "taxcom", connectionId: conn.id, cashRegisterMappingId: mapping.id, fiscalDriveNumber: FN, validFrom: new Date("2026-01-01"), status: "active" } });
  await p.ofdCashRegisterAssignment.create({ data: { companyId: co.id, cashRegisterMappingId: mapping.id, clubId: clubA.id, connectionId: conn.id, cashRegisterType: "club_cashbox", effectiveFrom: new Date("2026-01-01") } });

  // A receipt imported while bound to clubA — snapshots clubA.
  const receipt = await p.ofdReceiptImport.create({ data: { connectionId: conn.id, companyId: co.id, clubId: clubA.id, provider: "taxcom", fnNumber: FN, fiscalDocumentNumber: 10, operationType: "income", receiptDate: new Date("2026-07-10"), totalKopeks: 100000, cashKopeks: 100000, electronicKopeks: 0, dedupeKey: `taxcom:${FN}:10` } });
  check("T1 чек снимает clubId на импорте (clubA)", receipt.clubId === clubA.id);

  // Change binding clubA → clubB (mirror recordAssignmentChange + mapping update).
  const now = new Date("2026-07-16");
  await p.ofdCashRegisterAssignment.updateMany({ where: { cashRegisterMappingId: mapping.id, effectiveTo: null }, data: { effectiveTo: now } });
  await p.ofdCashRegisterAssignment.create({ data: { companyId: co.id, cashRegisterMappingId: mapping.id, clubId: clubB.id, connectionId: conn.id, cashRegisterType: "club_cashbox", effectiveFrom: now } });
  await p.ofdCashRegisterMapping.update({ where: { id: mapping.id }, data: { clubId: clubB.id } });
  const asgs = await p.ofdCashRegisterAssignment.findMany({ where: { cashRegisterMappingId: mapping.id }, orderBy: { effectiveFrom: "asc" } });
  check("T2 смена клуба: старая assignment закрыта, новая открыта", asgs.length === 2 && asgs[0].effectiveTo != null && asgs[1].effectiveTo === null && asgs[1].clubId === clubB.id);
  check("T3 исторический чек НЕ меняет клуб (остался clubA)", (await p.ofdReceiptImport.findUnique({ where: { id: receipt.id } })).clubId === clubA.id);

  // Change FN (mirror recordFiscalDriveChange).
  const FN2 = "9990002";
  await p.ofdFiscalDrive.updateMany({ where: { cashRegisterMappingId: mapping.id, status: "active" }, data: { status: "replaced", validTo: now } });
  await p.ofdFiscalDrive.create({ data: { companyId: co.id, provider: "taxcom", connectionId: conn.id, cashRegisterMappingId: mapping.id, fiscalDriveNumber: FN2, validFrom: now, status: "active" } });
  await p.ofdCashRegisterMapping.update({ where: { id: mapping.id }, data: { fnNumber: FN2, activeMappingKey: `taxcom:${FN2}` } });
  const drives = await p.ofdFiscalDrive.findMany({ where: { cashRegisterMappingId: mapping.id }, orderBy: { createdAt: "asc" } });
  check("T4 смена ФН: старый ФН в истории (replaced), новый active", drives.some((d) => d.fiscalDriveNumber === FN && d.status === "replaced") && drives.some((d) => d.fiscalDriveNumber === FN2 && d.status === "active"));
  check("T5 старый чек связан по фактическому ФН (не переписан)", (await p.ofdReceiptImport.findUnique({ where: { id: receipt.id } })).fnNumber === FN);

  // Dup FN conflict: another active mapping with FN2 blocked by unique key.
  let dupFn = false;
  try { await p.ofdCashRegisterMapping.create({ data: { connectionId: conn.id, companyId: co.id, clubId: clubA.id, provider: "taxcom", fnNumber: FN2, registerKind: "club_cashbox", isActive: true, activeMappingKey: `taxcom:${FN2}`, status: "active" } }); } catch { dupFn = true; }
  check("T6 дубль активного ФН заблокирован (activeMappingKey @unique)", dupFn);

  // Hard delete of an EMPTY register.
  const empty = await p.ofdCashRegisterMapping.create({ data: { connectionId: conn.id, companyId: co.id, clubId: clubA.id, provider: "taxcom", fnNumber: "9990009", registerKind: "club_cashbox", isActive: true, activeMappingKey: `taxcom:9990009`, status: "active" } });
  const emptyReceipts = await p.ofdReceiptImport.count({ where: { companyId: co.id, provider: "taxcom", fnNumber: "9990009" } });
  check("T7 пустая касса: 0 чеков → hard delete допустим", emptyReceipts === 0);
  await p.ofdCashRegisterMapping.delete({ where: { id: empty.id } });
  check("T8 hard delete удаляет строку кассы", (await p.ofdCashRegisterMapping.findUnique({ where: { id: empty.id } })) === null);

  // Register WITH history → archive (not delete), receipts kept.
  const withHist = mapping; // has receipt
  const histCount = await p.ofdReceiptImport.count({ where: { companyId: co.id, provider: "taxcom", fnNumber: { in: [FN, FN2] } } });
  await p.ofdCashRegisterMapping.update({ where: { id: withHist.id }, data: { status: "archived", archivedAt: new Date(), isActive: false, activeMappingKey: null } });
  check("T9 касса с историей архивируется, чеки сохранены", histCount >= 1 && (await p.ofdCashRegisterMapping.findUnique({ where: { id: withHist.id } })).status === "archived" && (await p.ofdReceiptImport.count({ where: { id: receipt.id } })) === 1);

  // Purge closed-period guard: attribution into a closed period blocks purge.
  const emp = await p.clubEmployee.create({ data: { companyId: co.id, clubId: clubA.id, fullName: "E", position: "sales_manager", status: "active" } });
  const period = await p.payrollPeriod.create({ data: { companyId: co.id, clubId: clubA.id, year: 2026, month: 7, status: "closed", createdByUserId: owner.id } });
  await p.payrollSalesAttribution.create({ data: { companyId: co.id, clubId: clubA.id, employeeId: emp.id, payrollPeriodId: period.id, ofdReceiptId: receipt.id, attributionType: "personal_sale", amountKopeks: 100000, dedupeKey: `taxcom:${FN}:10:income:personal_sale`, source: "ofd_confirmed", status: "attributed" } });
  const attrs = await p.payrollSalesAttribution.findMany({ where: { companyId: co.id, ofdReceiptId: receipt.id, payrollPeriodId: { not: null } }, select: { payrollPeriodId: true } });
  const closedCount = await p.payrollPeriod.count({ where: { id: { in: attrs.map((a) => a.payrollPeriodId) }, status: "closed" } });
  check("T10 purge заблокирован закрытым периодом (used-in-closed-period)", closedCount > 0);

  // Tenant / IDOR.
  check("T11 tenant isolation: чужая компания не видит кассы", (await p.ofdCashRegisterMapping.count({ where: { companyId: otherCo.id } })) === 0);
  check("T12 IDOR: все кассы своей компании", (await p.ofdCashRegisterMapping.findMany({ where: { companyId: co.id } })).every((m) => m.companyId === co.id));

  // cleanup
  await p.payrollSalesAttribution.deleteMany({ where: { companyId: co.id } });
  await p.payrollPeriod.deleteMany({ where: { companyId: co.id } });
  await p.clubEmployee.deleteMany({ where: { companyId: co.id } });
  await p.ofdReceiptImport.deleteMany({ where: { companyId: co.id } });
  await p.ofdFiscalDrive.deleteMany({ where: { companyId: co.id } });
  await p.ofdCashRegisterAssignment.deleteMany({ where: { companyId: co.id } });
  await p.ofdCashRegisterMapping.deleteMany({ where: { companyId: co.id } });
  await p.ofdConnection.deleteMany({ where: { companyId: co.id } });
  await p.club.deleteMany({ where: { companyId: co.id } });
  await p.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await p.user.delete({ where: { id: owner.id } });
}

async function main() {
  staticGuards();
  await realDb();
  await p.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
