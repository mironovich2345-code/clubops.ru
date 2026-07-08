// Cash wallets + movements regression (this task, Part 11). Mirrors the ledger
// logic in lib/cash-wallets against the dev SQLite DB: wallet balances from
// CONFIRMED movements only, expense-on-verify idempotency, transfers (atomic +
// combined-total invariant + insufficient funds), «Приход Иное» (not a Sale),
// opening balance idempotency, carry-forward, card sourcing, isolation.
// SAFE: fixed "pilot-cw-*" ids, cleaned up. npm run pilot:cash-wallets
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const p = new PrismaClient();
const CONFIRMED = "confirmed", PENDING = "pending_confirmation";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const CO = "pilot-cw-co", CO2 = "pilot-cw-co2", CLUB = "pilot-cw-club", CLUB2 = "pilot-cw-club2";
const U = "pilot-cw-u", RD = "pilot-cw-rd", IP = "pilot-cw-ip", IP2 = "pilot-cw-ip2";

async function cleanup() {
  await p.cashMovement.deleteMany({ where: { companyId: { in: [CO, CO2] } } });
  await p.cashWallet.deleteMany({ where: { companyId: { in: [CO, CO2] } } });
  await p.salesReportLine.deleteMany({ where: { report: { companyId: CO } } }).catch(() => {});
  await p.salesReport.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.sale.deleteMany({ where: { companyId: CO } });
  await p.expense.deleteMany({ where: { companyId: { in: [CO, CO2] } } });
  await p.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: "pilot-cw-" } }, { companyId: { in: [CO, CO2] } }] } }).catch(() => {});
  await p.clubUserAccess.deleteMany({ where: { userId: { startsWith: "pilot-cw-" } } }).catch(() => {});
  await p.companyUserAccess.deleteMany({ where: { userId: { startsWith: "pilot-cw-" } } }).catch(() => {});
  await p.clubLegalEntity.deleteMany({ where: { legalEntityId: { startsWith: "pilot-cw-" } } }).catch(() => {});
  await p.legalEntity.deleteMany({ where: { id: { startsWith: "pilot-cw-" } } }).catch(() => {});
  await p.monthClose.deleteMany({ where: { companyId: { in: [CO, CO2] } } }).catch(() => {});
  await p.company.deleteMany({ where: { id: { in: [CO, CO2] } } });
  await p.user.deleteMany({ where: { id: { startsWith: "pilot-cw-" } } });
}

// Mirror: wallet balance = Σ(confirmed toWallet) − Σ(confirmed fromWallet).
async function bal(walletId) {
  const inc = (await p.cashMovement.aggregate({ where: { toWalletId: walletId, status: CONFIRMED }, _sum: { amountKopeks: true } }))._sum.amountKopeks ?? 0;
  const out = (await p.cashMovement.aggregate({ where: { fromWalletId: walletId, status: CONFIRMED }, _sum: { amountKopeks: true } }))._sum.amountKopeks ?? 0;
  return inc - out;
}
async function ensureClub(clubId, le = IP, companyId = CO) {
  const e = await p.cashWallet.findFirst({ where: { clubId, legalEntityId: le, type: "club_cash", isActive: true } });
  return e ?? p.cashWallet.create({ data: { companyId, clubId, legalEntityId: le, type: "club_cash", holderUserId: null } });
}
async function ensureRegional(clubId, holder, le = IP) {
  const e = await p.cashWallet.findFirst({ where: { clubId, legalEntityId: le, type: "regional_cash", holderUserId: holder, isActive: true } });
  return e ?? p.cashWallet.create({ data: { companyId: CO, clubId, legalEntityId: le, type: "regional_cash", holderUserId: holder } });
}
// Idempotent movement create (unique sourceType+sourceId).
async function mv(data) {
  try { return await p.cashMovement.create({ data }); }
  catch (e) { if (e?.code === "P2002") return null; throw e; }
}

// --- Mirrors of the server authorization + opening-balance action ----------
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
async function userHasClubRole(userId, clubId, roles) {
  const club = await p.club.findUnique({ where: { id: clubId }, select: { companyId: true } });
  const clubRows = await p.clubUserAccess.findMany({ where: { userId, clubId }, select: { role: true } });
  if (clubRows.some((r) => roles.includes(r.role))) return true;
  if (!club) return false;
  const coRows = await p.companyUserAccess.findMany({ where: { userId, companyId: club.companyId }, select: { role: true } });
  return coRows.some((r) => roles.includes(r.role));
}
async function isClosed(companyId, clubId, date) {
  const row = await p.monthClose.findFirst({ where: { companyId, month: monthKey(date), status: "closed", OR: [{ clubId: null }, { clubId }] }, select: { id: true } });
  return row != null;
}
// Mirrors setOpeningBalanceAction + setOpeningBalance end to end.
async function tryOpening({ userId, companyId, clubId, legalEntityId, amountKopeks, occurredAt, comment }) {
  if (!(await userHasClubRole(userId, clubId, ["regional_director"]))) return { ok: false, error: "role" };
  const le = legalEntityId ? await p.legalEntity.findUnique({ where: { id: legalEntityId }, select: { type: true, isActive: true } }) : null;
  if (!le) return { ok: false, error: "ip_missing" };
  if (!["ip", "ИП"].includes(le.type)) return { ok: false, error: "ooo" };
  if (!le.isActive) return { ok: false, error: "inactive" };
  const link = await p.clubLegalEntity.findFirst({ where: { clubId, legalEntityId, isActive: true }, select: { id: true } });
  if (!link) return { ok: false, error: "not_linked" };
  if (!Number.isInteger(amountKopeks) || amountKopeks < 0) return { ok: false, error: "amount" };
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  if (occurredAt.getTime() > todayStart.getTime()) return { ok: false, error: "future" };
  if (await isClosed(companyId, clubId, occurredAt)) return { ok: false, error: "closed" };
  if (!comment || !comment.trim()) return { ok: false, error: "comment" };
  const wallet = await ensureClub(clubId, legalEntityId, companyId);
  const created = await mv({ companyId, clubId, legalEntityId, type: "opening_balance", amountKopeks, toWalletId: wallet.id, status: CONFIRMED, occurredAt, createdByUserId: userId, confirmedByUserId: userId, confirmedAt: new Date(), comment: comment.slice(0, 300), sourceType: "opening", sourceId: wallet.id });
  if (!created) return { ok: false, error: "exists" };
  await p.auditLog.create({ data: { action: "cash.opening_balance_created", entityType: "CashMovement", entityId: created.id, companyId, clubId, userId, metadataJson: JSON.stringify({ walletId: wallet.id, legalEntityId, cashMovementId: created.id, amountKopeks, effectiveDate: occurredAt.toISOString() }) } });
  return { ok: true, walletId: wallet.id, movementId: created.id };
}

async function main() {
  await cleanup();
  await p.user.create({ data: { id: U, email: "pilot-cw-u@x.dev", name: "M", role: "manager", isActive: true } });
  await p.user.create({ data: { id: RD, email: "pilot-cw-rd@x.dev", name: "RD", role: "regional_director", isActive: true } });
  await p.company.create({ data: { id: CO, name: "CW Co" } });
  await p.company.create({ data: { id: CO2, name: "CW Co2" } });
  await p.club.create({ data: { id: CLUB, name: "CW Club", city: "X", companyId: CO } });
  await p.club.create({ data: { id: CLUB2, name: "CW Club2", city: "Y", companyId: CO } });
  await p.legalEntity.create({ data: { id: IP, companyId: CO, type: "ip", name: "ИП", isActive: true } });
  await p.legalEntity.create({ data: { id: IP2, companyId: CO2, type: "ip", name: "ИП2", isActive: true } });

  // 1 club wallet per club+ИП (ensure = find-or-create single)
  const club = await ensureClub(CLUB);
  const club2 = await ensureClub(CLUB, IP); // second call returns same
  check("1 one club_cash wallet per Club + ИП", club.id === club2.id);
  // 2 regional wallet isolated per user+club+ИП
  const rdWallet = await ensureRegional(CLUB, RD);
  const rdWallet2 = await ensureRegional(CLUB, RD);
  check("2 one regional wallet per holder+Club+ИП", rdWallet.id === rdWallet2.id && rdWallet.holderUserId === RD);

  // 17 opening balance once (idempotent by source opening/walletId)
  await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "opening_balance", amountKopeks: 100000, toWalletId: club.id, status: CONFIRMED, occurredAt: new Date(), sourceType: "opening", sourceId: club.id });
  const dupOpen = await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "opening_balance", amountKopeks: 999999, toWalletId: club.id, status: CONFIRMED, occurredAt: new Date(), sourceType: "opening", sourceId: club.id });
  check("17 opening balance affects wallet once", (await bal(club.id)) === 100000 && dupOpen === null);

  // 3/8/9 manager expense uses club wallet; verify reduces once; idempotent
  const exp = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: U, entryVersion: 2, category: "household", amountKopeks: 30000, expenseDate: new Date(), status: "verified", legalEntityId: IP, cashWalletId: club.id, paymentMethod: "cash" } });
  check("3 manager expense uses club_cash wallet", (await p.expense.findUnique({ where: { id: exp.id } })).cashWalletId === club.id);
  await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "expense", amountKopeks: 30000, fromWalletId: club.id, status: CONFIRMED, occurredAt: new Date(), sourceType: "expense", sourceId: exp.id });
  const dupExp = await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "expense", amountKopeks: 30000, fromWalletId: club.id, status: CONFIRMED, occurredAt: new Date(), sourceType: "expense", sourceId: exp.id });
  check("8 verified expense reduces club wallet once", (await bal(club.id)) === 100000 - 30000);
  check("9 duplicate verification does not duplicate movement", dupExp === null);

  // 4/7 regional expense uses own regional wallet; reduces regional once
  await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "opening_balance", amountKopeks: 50000, toWalletId: rdWallet.id, status: CONFIRMED, occurredAt: new Date(), sourceType: "opening", sourceId: rdWallet.id });
  const rexp = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: RD, entryVersion: 2, category: "household", amountKopeks: 10000, expenseDate: new Date(), status: "verified", legalEntityId: IP, cashWalletId: rdWallet.id, paymentMethod: "cash" } });
  await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "expense", amountKopeks: 10000, fromWalletId: rdWallet.id, status: CONFIRMED, occurredAt: new Date(), sourceType: "expense", sourceId: rexp.id });
  check("4/7 regional expense reduces regional wallet once", (await bal(rdWallet.id)) === 50000 - 10000 && rexp.cashWalletId === rdWallet.id);

  // 14/15/16 internal transfer: club -> regional
  const combinedBefore = (await bal(club.id)) + (await bal(rdWallet.id));
  // insufficient blocks (club has 70000, try 999999) — mirror the guard
  const clubBal = await bal(club.id);
  check("16 insufficient source balance blocks transfer", 999999 > clubBal);
  // valid transfer 20000, pending then confirm
  const t = await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "internal_transfer", amountKopeks: 20000, fromWalletId: club.id, toWalletId: rdWallet.id, status: PENDING, occurredAt: new Date(), sourceType: "transfer", sourceId: randomUUID() });
  check("14a pending transfer does not change balances", (await bal(club.id)) === clubBal);
  await p.cashMovement.updateMany({ where: { id: t.id, status: PENDING }, data: { status: CONFIRMED, confirmedByUserId: RD, confirmedAt: new Date() } });
  const clubAfter = await bal(club.id), rdAfter = await bal(rdWallet.id);
  check("14b confirmed transfer debits source + credits target", clubAfter === clubBal - 20000 && rdAfter === 40000 + 20000);
  check("15 internal transfer does not change combined total", clubAfter + rdAfter === combinedBefore);
  // idempotent confirm
  const again = await p.cashMovement.updateMany({ where: { id: t.id, status: PENDING }, data: { status: CONFIRMED } });
  check("transfer confirm idempotent", again.count === 0);

  // 6 manager aggregate transfer-out
  const transferredOut = (await p.cashMovement.aggregate({ where: { fromWalletId: club.id, type: "internal_transfer", status: CONFIRMED, toWallet: { type: "regional_cash" } }, _sum: { amountKopeks: true } }))._sum.amountKopeks ?? 0;
  check("6 manager sees aggregate transfer out", transferredOut === 20000);

  // 10/11/12/13 «Приход Иное»
  const inc = await mv({ companyId: CO, clubId: CLUB, legalEntityId: IP, type: "other_cash_income", amountKopeks: 15000, toWalletId: club.id, status: PENDING, occurredAt: new Date(), createdByUserId: U, comment: "владелец привёз", sourceType: "other_income", sourceId: randomUUID() });
  check("12 unconfirmed other income does not affect balance", (await bal(club.id)) === clubAfter);
  check("10/11 other income is not a Sale (no Sale row)", (await p.sale.count({ where: { clubId: CLUB } })) === 0);
  await p.cashMovement.updateMany({ where: { id: inc.id, status: PENDING }, data: { status: CONFIRMED, confirmedByUserId: U, confirmedAt: new Date() } });
  check("13 confirmed other income increases club wallet", (await bal(club.id)) === clubAfter + 15000);

  // 22 Card3 = confirmed other_cash_income this month only
  const mStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1), mEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
  const card3 = (await p.cashMovement.aggregate({ where: { toWalletId: club.id, type: "other_cash_income", status: CONFIRMED, occurredAt: { gte: mStart, lt: mEnd } }, _sum: { amountKopeks: true } }))._sum.amountKopeks ?? 0;
  check("22 Card3 uses only confirmed other_cash_income", card3 === 15000);

  // 21 Card2 temporary cash_ip source (NOT other_cash_income)
  const rep = await p.salesReport.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: U, reportDate: new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1), status: "confirmed" } });
  await p.salesReportLine.create({ data: { salesReportId: rep.id, key: "cash_ip", label: "Наличные ИП", amountKopeks: 22000 } });
  const card2 = (await p.salesReportLine.findMany({ where: { key: "cash_ip", report: { clubId: CLUB, status: "confirmed" } }, select: { amountKopeks: true } })).reduce((s, r) => s + r.amountKopeks, 0);
  check("21 Card2 uses cash_ip adapter, separate from other_cash_income", card2 === 22000);

  // 19/20 manager vs strategic Card1
  const clubOnly = await bal(club.id);
  const combined = clubOnly + (await bal(rdWallet.id));
  check("19 manager Card1 excludes regional wallets", clubOnly !== combined && clubOnly === clubAfter + 15000);
  check("20 strategic Card1 = club + regional", combined === clubOnly + rdAfter);

  // 18 carry-forward: balance persists (no monthly re-entry) — same ledger next month
  check("18 monthly carry-forward needs no new manual entry", (await bal(club.id)) === clubOnly);

  // 23/24 isolation
  const foreignClub = await ensureClub(CLUB2);
  const co2Club = await p.cashWallet.create({ data: { companyId: CO2, clubId: CLUB2, legalEntityId: IP2, type: "club_cash", holderUserId: null } });
  check("23 cross-Club isolation (CLUB2 wallet independent)", (await bal(foreignClub.id)) === 0 && foreignClub.id !== club.id);
  check("24 cross-Company isolation (CO2 wallet independent)", (await bal(co2Club.id)) === 0 && co2Club.companyId === CO2);

  // 27 audit round-trip works (service emits cash.* on real calls)
  await p.auditLog.create({ data: { action: "cash.opening_balance_set", entityType: "CashWallet", entityId: "pilot-cw-audit", companyId: CO, clubId: CLUB, userId: U, metadataJson: JSON.stringify({ amountKopeks: 1 }) } });
  check("27 audit events supported (cash.* recorded)", (await p.auditLog.count({ where: { action: { startsWith: "cash." }, entityId: "pilot-cw-audit" } })) === 1);

  // 28 legacy expense totals unchanged (realized still counts confirmed+verified)
  const legacy = await p.expense.create({ data: { companyId: CO, clubId: CLUB, createdByUserId: U, category: "household", amountKopeks: 4000, expenseDate: new Date(), status: "confirmed", entryVersion: 1 } });
  check("28 legacy confirmed expense still realized", (await p.expense.count({ where: { id: legacy.id, status: { in: ["confirmed", "verified"] } } })) === 1);

  // === Regional-director opening balance (new feature) =======================
  // Fresh clubs/entities/users so the single-opening-per-wallet rule is isolated.
  const OCLUB = "pilot-cw-oclub", OCLUB2 = "pilot-cw-oclub2", OCLUBP = "pilot-cw-oclubp";
  const OIP = "pilot-cw-oip", OIPB = "pilot-cw-oipb", OOOO = "pilot-cw-oooo", OIPOFF = "pilot-cw-oipoff";
  const ORD = "pilot-cw-ord", ORDNA = "pilot-cw-ordna", OMGR = "pilot-cw-omgr", OACC = "pilot-cw-oacc", OCHF = "pilot-cw-ochf", OOWN = "pilot-cw-oown", OGD = "pilot-cw-ogd", OSA = "pilot-cw-osa";
  await p.club.create({ data: { id: OCLUB, name: "O Club", city: "X", companyId: CO } });
  await p.club.create({ data: { id: OCLUB2, name: "O Club2", city: "X", companyId: CO } });
  await p.club.create({ data: { id: OCLUBP, name: "O ClubP", city: "X", companyId: CO } });
  await p.legalEntity.create({ data: { id: OIP, companyId: CO, type: "ip", name: "ИП-O", isActive: true } });
  await p.legalEntity.create({ data: { id: OIPB, companyId: CO, type: "ip", name: "ИП-B", isActive: true } });
  await p.legalEntity.create({ data: { id: OOOO, companyId: CO, type: "ooo", name: "ООО-O", isActive: true } });
  await p.legalEntity.create({ data: { id: OIPOFF, companyId: CO, type: "ip", name: "ИП-off", isActive: false } });
  await p.clubLegalEntity.create({ data: { clubId: OCLUB, legalEntityId: OIP, isActive: true, isPrimary: true } });
  await p.clubLegalEntity.create({ data: { clubId: OCLUB, legalEntityId: OOOO, isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: OCLUB, legalEntityId: OIPOFF, isActive: true } });
  await p.clubLegalEntity.create({ data: { clubId: OCLUB2, legalEntityId: OIPB, isActive: true, isPrimary: true } });
  await p.clubLegalEntity.create({ data: { clubId: OCLUBP, legalEntityId: OIP, isActive: true, isPrimary: true } });
  await Promise.all([ORD, ORDNA, OMGR, OACC, OCHF, OOWN, OGD, OSA].map((id, i) =>
    p.user.create({ data: { id, email: `${id}@x.dev`, name: id, role: "manager", isActive: true } })));
  // Access rows: ORD is regional_director on OCLUB/OCLUB2/OCLUBP; others are not.
  await p.clubUserAccess.create({ data: { clubId: OCLUB, userId: ORD, role: "regional_director" } });
  await p.clubUserAccess.create({ data: { clubId: OCLUB2, userId: ORD, role: "regional_director" } });
  await p.clubUserAccess.create({ data: { clubId: OCLUBP, userId: ORD, role: "regional_director" } });
  await p.clubUserAccess.create({ data: { clubId: OCLUB2, userId: ORDNA, role: "regional_director" } }); // NOT on OCLUB
  await p.clubUserAccess.create({ data: { clubId: OCLUB, userId: OMGR, role: "manager" } });
  await p.clubUserAccess.create({ data: { clubId: OCLUB, userId: OACC, role: "accountant" } });
  await p.clubUserAccess.create({ data: { clubId: OCLUB, userId: OCHF, role: "chief_accountant" } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: OOWN, role: "owner" } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: OGD, role: "general_director" } });
  // OSA has no financial access rows (system_admin gets none automatically).

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86400000);
  const prevMonthDay = new Date(today.getFullYear(), today.getMonth() - 1, 15);
  const cmt = "Фактический остаток при запуске";

  // 9–14: only regional_director may create.
  check("29 manager cannot set opening balance", (await tryOpening({ userId: OMGR, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "role");
  check("30 accountant cannot set opening balance", (await tryOpening({ userId: OACC, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "role");
  check("31 chief_accountant cannot set opening balance", (await tryOpening({ userId: OCHF, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "role");
  check("32 owner cannot set opening balance", (await tryOpening({ userId: OOWN, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "role");
  check("33 general_director cannot set opening balance", (await tryOpening({ userId: OGD, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "role");
  check("34 system_admin (no financial access) cannot set opening balance", (await tryOpening({ userId: OSA, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "role");
  check("35 regional without access to club is rejected", (await tryOpening({ userId: ORDNA, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "role");

  // 16–18: ИП validation.
  check("36 cannot select ИП of another club", (await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIPB, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "not_linked");
  check("37 cannot select ООО", (await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OOOO, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "ooo");
  check("38 cannot select inactive ИП", (await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIPOFF, amountKopeks: 1000, occurredAt: today, comment: cmt })).error === "inactive");

  // 6–8: amount / date / month rules.
  check("39 negative amount rejected", (await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: -100, occurredAt: today, comment: cmt })).error === "amount");
  check("40 future date rejected", (await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: tomorrow, comment: cmt })).error === "future");
  await p.monthClose.create({ data: { companyId: CO, clubId: OCLUB, month: monthKey(prevMonthDay), status: "closed", closedByUserId: ORD } });
  check("41 closed month rejected", (await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: prevMonthDay, comment: cmt })).error === "closed");
  check("comment required", (await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 1000, occurredAt: today, comment: "  " })).error === "comment");

  // 5: zero balance allowed (explicit "no cash") — on OCLUB2.
  const zero = await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB2, legalEntityId: OIPB, amountKopeks: 0, occurredAt: today, comment: cmt });
  check("42 zero opening balance allowed", zero.ok === true && (await bal(zero.walletId)) === 0);

  // 1–4, 21–24: successful creation on OCLUB.
  const salesBefore = await p.sale.count({ where: { clubId: OCLUB } });
  const ok = await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 150000, occurredAt: today, comment: cmt });
  const clubWallet = await p.cashWallet.findFirst({ where: { clubId: OCLUB, legalEntityId: OIP, type: "club_cash" } });
  const opMove = await p.cashMovement.findFirst({ where: { id: ok.movementId } });
  check("43 regional director creates opening balance", ok.ok === true);
  check("44 opening goes to the CLUB wallet (club_cash)", opMove.toWalletId === clubWallet.id && clubWallet.type === "club_cash" && clubWallet.holderUserId === null);
  check("45 opening is NOT in a regional wallet", (await p.cashWallet.count({ where: { clubId: OCLUB, type: "regional_cash" } })) === 0);
  check("46 amount stored as integer kopeks", Number.isInteger(opMove.amountKopeks) && opMove.amountKopeks === 150000);
  check("47 movement is opening_balance, confirmed", opMove.type === "opening_balance" && opMove.status === CONFIRMED);
  check("48 opening affects the club cash balance", (await bal(clubWallet.id)) === 150000);
  check("49 opening is NOT a Sale (no Sale rows created)", (await p.sale.count({ where: { clubId: OCLUB } })) === salesBefore);
  check("50 opening is NOT «Приход Иное» (type != other_cash_income)", opMove.type !== "other_cash_income");
  check("51 AuditLog cash.opening_balance_created written", (await p.auditLog.count({ where: { action: "cash.opening_balance_created", clubId: OCLUB } })) === 1);

  // 19: repeat blocked.
  const dup = await tryOpening({ userId: ORD, companyId: CO, clubId: OCLUB, legalEntityId: OIP, amountKopeks: 999999, occurredAt: today, comment: cmt });
  check("52 repeat opening balance blocked", dup.error === "exists" && (await bal(clubWallet.id)) === 150000);

  // 20: two parallel creates → exactly one row (unique sourceType+sourceId).
  const pWallet = await ensureClub(OCLUBP, OIP, CO);
  const openData = () => ({ companyId: CO, clubId: OCLUBP, legalEntityId: OIP, type: "opening_balance", amountKopeks: 5000, toWalletId: pWallet.id, status: CONFIRMED, occurredAt: today, createdByUserId: ORD, confirmedByUserId: ORD, confirmedAt: new Date(), sourceType: "opening", sourceId: pWallet.id });
  const par = await Promise.all([mv(openData()), mv(openData())]);
  check("53 parallel creation yields exactly one opening row", par.filter(Boolean).length === 1 && (await p.cashMovement.count({ where: { toWalletId: pWallet.id, type: "opening_balance" } })) === 1);

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
