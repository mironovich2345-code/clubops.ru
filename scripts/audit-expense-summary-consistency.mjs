// Diagnostic reconciliation: expenses list «На проверке» vs the ИП cash card
// «Расходы ИП на проверке». Read-only — never mutates. Explains, per expense, why it
// is in one set and not the other (scope: club/ИП/cash/v2; or status delta).
//
// Status buckets MIRROR src/lib/expense-status.ts (the single source of truth). Money is
// integer kopeks throughout — no JS float, so the diff is exact.
//
//   node scripts/audit-expense-summary-consistency.mjs [companyId]
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Mirror of src/lib/expense-status.ts
const REVIEW = ["submitted", "pending_regional_budget_approval", "pending_owner_budget_approval", "pending_accountant_verification", "waiting_budget_approval"];
const NEEDS_CORRECTION = "needs_correction";
const CASH_PENDING = [...REVIEW, NEEDS_CORRECTION];
const fmt = (k) => `${(k / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

async function main() {
  const argCompany = process.argv[2];
  const company = argCompany
    ? await prisma.company.findUnique({ where: { id: argCompany } })
    : await prisma.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (!company) { console.log("Нет компаний в БД."); return; }

  const clubs = await prisma.club.findMany({ where: { companyId: company.id }, select: { id: true, name: true } });
  const clubIds = clubs.map((c) => c.id);
  console.log(`Компания: ${company.name} (${company.id}) · клубов: ${clubIds.length}\n`);

  // Active ИП per club (ClubLegalEntity isActive + LegalEntity.type=ip).
  const links = await prisma.clubLegalEntity.findMany({
    where: { clubId: { in: clubIds }, isActive: true, legalEntity: { type: "ip", isActive: true } },
    select: { clubId: true, legalEntityId: true },
  });
  const ipByClub = new Map(links.map((l) => [l.clubId, l.legalEntityId]));

  // All non-draft expenses in scope.
  const expenses = await prisma.expense.findMany({
    where: { companyId: company.id, clubId: { in: clubIds }, status: { not: "draft" } },
    select: { id: true, clubId: true, legalEntityId: true, paymentMethod: true, entryVersion: true, status: true, amountKopeks: true, expenseDate: true, category: true },
    orderBy: { expenseDate: "desc" },
  });

  const clubName = (id) => clubs.find((c) => c.id === id)?.name ?? id;
  const rows = [];
  let listReviewTotal = 0;   // «На проверке» across whole scope
  let cardPendingTotal = 0;  // ИП cash pending across all clubs (this club's ИП, cash, v2)

  for (const e of expenses) {
    const inList = REVIEW.includes(e.status); // list «На проверке»
    const ipId = ipByClub.get(e.clubId) ?? null;
    const inCard =
      CASH_PENDING.includes(e.status) &&
      e.legalEntityId === ipId &&
      e.paymentMethod === "cash" &&
      e.entryVersion === 2;
    if (inList) listReviewTotal += e.amountKopeks;
    if (inCard) cardPendingTotal += e.amountKopeks;
    if (inList === inCard) continue; // only surface the divergence

    const reasons = [];
    if (e.status === NEEDS_CORRECTION) reasons.push("статус needs_correction (в списке — вкладка «Требуют исправления», в карточке — cash-pending)");
    if (!CASH_PENDING.includes(e.status) && inList) reasons.push(`статус ${e.status} вне cash-pending`);
    if (inList && e.legalEntityId !== ipId) reasons.push(e.legalEntityId ? "юрлицо ≠ активное ИП клуба (ООО/другое)" : "юрлицо не указано");
    if (inList && e.paymentMethod !== "cash") reasons.push(`оплата ${e.paymentMethod ?? "—"} ≠ наличные`);
    if (inList && e.entryVersion !== 2) reasons.push(`entryVersion ${e.entryVersion} (legacy v1)`);
    rows.push({ id: e.id, date: e.expenseDate.toISOString().slice(0, 10), club: clubName(e.clubId), status: e.status, amount: e.amountKopeks, inList, inCard, why: reasons.join("; ") || "—" });
  }

  console.log("Расхождения (в одном наборе, но не в другом):");
  for (const r of rows) {
    console.log(`  ${r.id} · ${r.date} · ${r.club} · ${r.status} · ${fmt(r.amount)} · list=${r.inList} card=${r.inCard} · ${r.why}`);
  }
  console.log(`\nИтоги (kopeks-exact):`);
  console.log(`  Список «На проверке» (весь scope)         : ${fmt(listReviewTotal)}  [${listReviewTotal}]`);
  console.log(`  Карточка «Расходы ИП на проверке» (сумма) : ${fmt(cardPendingTotal)}  [${cardPendingTotal}]`);
  console.log(`  Разница                                   : ${fmt(listReviewTotal - cardPendingTotal)}  [${listReviewTotal - cardPendingTotal}]`);
  console.log(`  Расхождений строк                         : ${rows.length}`);
  console.log(`\nВывод: карточка — узкий набор (этот клуб, ИП, наличные, v2, cash-pending),`);
  console.log(`список «На проверке» — весь scope (все клубы/юрлица, review-статусы). Разница ожидаема;`);
  console.log(`статусная дефиниция теперь общая (src/lib/expense-status.ts). Данные не изменялись.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
