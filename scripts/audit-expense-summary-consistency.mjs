// Diagnostic reconciliation (READ-ONLY — never mutates): the ИП cash card
// «Расходы ИП на проверке» for ONE club vs the expenses lists «На проверке» +
// «Требуют исправления» across the company scope. Explains the difference down to
// individual expense IDs and an exact, self-checked arithmetic decomposition:
//
//   Σ(списки)  − другие клубы − ООО − безнал(не-ООО) − прочие  =  Σ(карточка)
//
// Money is integer kopeks throughout — the diff is exact (no JS float). Status buckets
// MIRROR src/lib/expense-status.ts (the single source of truth).
//
// Usage:
//   node scripts/audit-expense-summary-consistency.mjs --company "ПИТЕР СПОРТ" --club "Союз" --month 2026-07
//   (company/club match by id OR case-insensitive name; --month optional YYYY-MM)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Mirror of src/lib/expense-status.ts
const REVIEW = ["submitted", "pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "waiting_budget_approval"];
const NEEDS_CORRECTION = "needs_correction";
const CASH_PENDING = [...REVIEW, NEEDS_CORRECTION];

const fmt = (k) => `${(k / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

function parseArgs(argv) {
  const a = { company: null, club: null, month: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--company") a.company = argv[++i];
    else if (argv[i] === "--club") a.club = argv[++i];
    else if (argv[i] === "--month") a.month = argv[++i];
    else if (!a.company) a.company = argv[i];
    else if (!a.club) a.club = argv[i];
    else if (!a.month) a.month = argv[i];
  }
  return a;
}

function monthRange(m) {
  if (!m) return null;
  const mm = /^(\d{4})-(\d{2})$/.exec(m);
  if (!mm) return null;
  const y = Number(mm[1]), mo = Number(mm[2]) - 1;
  return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1), label: m };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = monthRange(args.month);
  if (args.month && !range) { console.log(`Некорректный --month «${args.month}» (ожидается YYYY-MM).`); return; }

  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const company = args.company
    ? companies.find((c) => c.id === args.company) || companies.find((c) => c.name.toLowerCase().includes(args.company.toLowerCase()))
    : companies[0];
  if (!company) { console.log(`Компания не найдена: «${args.company ?? "(первая)"}». Доступные: ${companies.map((c) => c.name).join(", ") || "нет"}`); return; }

  const clubs = await prisma.club.findMany({ where: { companyId: company.id }, select: { id: true, name: true } });
  const clubIds = clubs.map((c) => c.id);
  const target = args.club
    ? clubs.find((c) => c.id === args.club) || clubs.find((c) => c.name.toLowerCase().includes(args.club.toLowerCase()))
    : null;
  if (args.club && !target) { console.log(`Клуб не найден: «${args.club}» в компании ${company.name}. Клубы: ${clubs.map((c) => c.name).join(", ") || "нет"}`); return; }

  // Legal entities of the company (id → name/type) + the target club's ACTIVE ИП.
  const leRows = await prisma.legalEntity.findMany({ where: { companyId: company.id }, select: { id: true, name: true, type: true } });
  const leById = new Map(leRows.map((e) => [e.id, e]));
  let activeIpId = null, activeIpName = null, openingDate = null;
  if (target) {
    const link = await prisma.clubLegalEntity.findFirst({
      where: { clubId: target.id, isActive: true, legalEntity: { type: "ip", isActive: true } },
      select: { legalEntityId: true },
    });
    activeIpId = link?.legalEntityId ?? null;
    activeIpName = activeIpId ? leById.get(activeIpId)?.name ?? activeIpId : null;
    if (activeIpId) {
      const snap = await prisma.balanceSnapshot.findFirst({
        where: { clubId: target.id, legalEntityId: activeIpId },
        orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }], select: { snapshotDate: true },
      });
      openingDate = snap?.snapshotDate ?? null;
    }
  }

  const where = { companyId: company.id, clubId: { in: clubIds }, status: { not: "draft" } };
  if (range) where.expenseDate = { gte: range.start, lt: range.end };
  const expenses = await prisma.expense.findMany({
    where,
    select: { id: true, clubId: true, legalEntityId: true, paymentMethod: true, entryVersion: true, status: true, amountKopeks: true, expenseDate: true, category: true },
    orderBy: { expenseDate: "asc" },
  });

  const clubName = (id) => clubs.find((c) => c.id === id)?.name ?? id;
  const leLabel = (id) => (id ? `${leById.get(id)?.name ?? id} (${(leById.get(id)?.type ?? "?").toUpperCase()})` : "— не указано —");

  // ---- Lists (whole company scope) ----
  const reviewRows = expenses.filter((e) => REVIEW.includes(e.status));
  const correctionRows = expenses.filter((e) => e.status === NEEDS_CORRECTION);
  const listRows = [...reviewRows, ...correctionRows]; // = cash-pending statuses
  const sum = (rows) => rows.reduce((a, r) => a + r.amountKopeks, 0);
  const reviewTotal = sum(reviewRows), correctionTotal = sum(correctionRows), listsTotal = reviewTotal + correctionTotal;

  // ---- Card (target club, active ИП, cash, v2, cash-pending) ----
  const isCard = (e) => target && e.clubId === target.id && e.legalEntityId === activeIpId && e.paymentMethod === "cash" && e.entryVersion === 2 && CASH_PENDING.includes(e.status);
  const cardRows = target ? listRows.filter(isCard) : [];
  const cardTotal = sum(cardRows);

  // ---- Mutually-exclusive exclusion buckets over (lists \ card), priority A>B>C>D ----
  const bucket = { otherClubs: [], ooo: [], beznal: [], prochie: [] };
  for (const e of listRows) {
    if (isCard(e)) continue;
    if (!target || e.clubId !== target.id) bucket.otherClubs.push(e);
    else if (leById.get(e.legalEntityId)?.type === "ooo") bucket.ooo.push(e);
    else if (e.paymentMethod !== "cash") bucket.beznal.push(e);
    else bucket.prochie.push(e); // target+ИП/other+cash, но v1 / не активное ИП / без юрлица
  }
  const bt = { otherClubs: sum(bucket.otherClubs), ooo: sum(bucket.ooo), beznal: sum(bucket.beznal), prochie: sum(bucket.prochie) };

  // ---------------- Report ----------------
  console.log(`\n=== Сверка расходов (READ-ONLY) ===`);
  console.log(`Компания : ${company.name} (${company.id})`);
  console.log(`Клуб     : ${target ? `${target.name} (${target.id})` : "— не задан (карточка не считается)"}`);
  console.log(`Месяц    : ${range ? range.label : "весь период (без фильтра по месяцу)"}`);
  console.log(`Активное ИП клуба: ${activeIpName ?? "—"}   Контрольный остаток ИП: ${openingDate ? openingDate.toISOString().slice(0, 10) : "не задан"}`);
  if (range && openingDate) console.log(`⚠ Живая карточка считает расходы ПОСЛЕ контрольного остатка, а не строго за месяц — при несовпадении даты чек-поинта и начала месяца сумма может отличаться.`);
  console.log(`⚠ Живой список на странице НЕ фильтруется по месяцу — здесь фильтр по месяцу применён по запросу.\n`);

  console.log(`1) Карточка «Расходы ИП на проверке» (${target ? target.name : "—"}): ${fmt(cardTotal)}  [${cardTotal}] · строк: ${cardRows.length}`);
  console.log(`2) Список «На проверке» (весь scope компании)            : ${fmt(reviewTotal)}  [${reviewTotal}] · строк: ${reviewRows.length}`);
  console.log(`3) Список «Требуют исправления» (весь scope компании)    : ${fmt(correctionTotal)}  [${correctionTotal}] · строк: ${correctionRows.length}`);
  console.log(`   Σ списков (2+3)                                       : ${fmt(listsTotal)}  [${listsTotal}]`);

  console.log(`\n4) Expense ID, входящие в карточку (${cardRows.length}):`);
  for (const e of cardRows) console.log(`   ${e.id} · ${e.expenseDate.toISOString().slice(0, 10)} · ${e.status} · ${fmt(e.amountKopeks)}`);
  if (!cardRows.length) console.log(`   — нет —`);

  const excluded = [...bucket.otherClubs, ...bucket.ooo, ...bucket.beznal, ...bucket.prochie];
  console.log(`\n5) Expense ID, показанные в списках, но НЕ в карточке (${excluded.length}):`);
  console.log(`\n6) Детализация исключённых строк:`);
  const reason = (e) =>
    (!target || e.clubId !== target.id) ? "другой клуб"
      : leById.get(e.legalEntityId)?.type === "ooo" ? "юрлицо ООО (не ИП)"
      : e.paymentMethod !== "cash" ? `безналичная оплата (${e.paymentMethod ?? "—"})`
      : e.legalEntityId !== activeIpId ? (e.legalEntityId ? "не активное ИП клуба" : "юрлицо не указано")
      : e.entryVersion !== 2 ? `legacy v1 (entryVersion=${e.entryVersion})`
      : "прочее";
  for (const e of excluded) {
    console.log(`   ${e.id} · ${fmt(e.amountKopeks)} · клуб=${clubName(e.clubId)} · юрлицо=${leLabel(e.legalEntityId)} · оплата=${e.paymentMethod ?? "—"} · статус=${e.status} · причина=${reason(e)}`);
  }
  if (!excluded.length) console.log(`   — нет —`);

  console.log(`\n7) Итоговая математическая сверка (kopeks-exact):`);
  console.log(`   Σ списков (На проверке + Требуют исправления) : ${fmt(listsTotal)}  [${listsTotal}]`);
  console.log(`   − расходы других клубов                       : ${fmt(bt.otherClubs)}  [${bt.otherClubs}] · строк ${bucket.otherClubs.length}`);
  console.log(`   − расходы ООО (этот клуб)                      : ${fmt(bt.ooo)}  [${bt.ooo}] · строк ${bucket.ooo.length}`);
  console.log(`   − безналичные (этот клуб, не-ООО)              : ${fmt(bt.beznal)}  [${bt.beznal}] · строк ${bucket.beznal.length}`);
  console.log(`   − прочие исключения (v1 / не активное ИП / без юрлица) : ${fmt(bt.prochie)}  [${bt.prochie}] · строк ${bucket.prochie.length}`);
  const derived = listsTotal - bt.otherClubs - bt.ooo - bt.beznal - bt.prochie;
  console.log(`   = сумма карточки (расчёт)                     : ${fmt(derived)}  [${derived}]`);
  console.log(`   = сумма карточки (факт)                       : ${fmt(cardTotal)}  [${cardTotal}]`);
  console.log(`   Проверка тождества                            : ${derived === cardTotal ? "✅ СХОДИТСЯ (точно, до копейки)" : `❌ РАСХОЖДЕНИЕ ${fmt(derived - cardTotal)} [${derived - cardTotal}] — расследовать`}`);
  console.log(`\nДанные НЕ изменялись (read-only).`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
