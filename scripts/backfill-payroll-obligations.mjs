// Idempotent backfill for the Payroll → Payment Planning rollout (spec §30): create
// «Зарплата к выплате» obligations for periods already APPROVED before the feature shipped.
// Creates NO budget change and NO obligations for draft/unapproved periods. Re-running is safe
// (idempotencyKey upsert). Dry-run by default.
//   node scripts/backfill-payroll-obligations.mjs            (dry-run — reports only)
//   node scripts/backfill-payroll-obligations.mjs --apply    (writes obligations)
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const APPROVED = new Set(["approved", "partially_paid", "paid", "closed"]);
const APPLY = process.argv.includes("--apply");

// Mirror of forecastCategoryOfPosition (kept inline so this script is dependency-free).
function forecastCategoryOfPosition(position) {
  switch (position) {
    case "manager": return "management";
    case "sales_manager": case "administrator": case "night_manager": return "administrative";
    case "head_gym_trainer": case "gym_trainer": return "gym_trainers";
    case "head_group_trainer": case "group_trainer": return "group_trainers";
    default: return "other";
  }
}

function resolveDueDate(year, month, day, weekendRule) {
  if (!day || day < 1 || day > 31) return null;
  const lastDay = new Date(year, month, 0).getDate();
  const d = new Date(year, month - 1, Math.min(day, lastDay));
  const dow = d.getDay();
  if (weekendRule === "shift_earlier") { if (dow === 6) d.setDate(d.getDate() - 1); else if (dow === 0) d.setDate(d.getDate() - 2); }
  else if (weekendRule === "shift_later") { if (dow === 6) d.setDate(d.getDate() + 2); else if (dow === 0) d.setDate(d.getDate() + 1); }
  return d;
}

function statusOf(amount, paid, dueDate, now) {
  if (paid >= amount && amount > 0) return "paid";
  if (paid > 0) return "partially_paid";
  if (dueDate && dueDate.getTime() <= now.getTime()) return "due";
  return "planned";
}

async function main() {
  const now = new Date();
  const periods = (await prisma.payrollPeriod.findMany()).filter((p) => APPROVED.has(p.status));
  let created = 0, updated = 0, skipped = 0, periodsTouched = 0;
  const report = [];

  for (const period of periods) {
    const calcs = await prisma.payrollCalculation.findMany({
      where: { payrollPeriodId: period.id },
      select: { legalEntityId: true, roleSnapshot: true, netPayableKopeks: true, paidKopeks: true },
    });
    if (calcs.length === 0) { skipped += 1; continue; }

    const clubLink = await prisma.clubLegalEntity.findFirst({ where: { clubId: period.clubId, isActive: true }, orderBy: { isPrimary: "desc" }, select: { legalEntityId: true } });
    const clubPrimaryLE = clubLink?.legalEntityId ?? "";
    const company = await prisma.company.findUnique({ where: { id: period.companyId }, select: { payrollFinalDay: true, payrollWeekendRule: true } });
    const dueDate = resolveDueDate(period.year, period.month, company?.payrollFinalDay ?? null, company?.payrollWeekendRule ?? null);

    const slices = new Map();
    for (const c of calcs) {
      const le = c.legalEntityId ?? clubPrimaryLE ?? "";
      const category = forecastCategoryOfPosition(c.roleSnapshot);
      const key = `${le}|${category}`;
      const cur = slices.get(key) ?? { legalEntityId: le, category, amount: 0, paid: 0 };
      cur.amount += c.netPayableKopeks;
      cur.paid += c.paidKopeks;
      slices.set(key, cur);
    }

    let touched = false;
    for (const s of slices.values()) {
      if (s.amount <= 0) { skipped += 1; continue; }
      const remaining = Math.max(0, s.amount - s.paid);
      const status = statusOf(s.amount, s.paid, dueDate, now);
      const idempotencyKey = `${period.companyId}:${period.clubId}:${s.legalEntityId}:${s.category}:${period.id}:final_salary`;
      const existing = await prisma.payrollPaymentObligation.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (existing.status === "cancelled") { skipped += 1; continue; }
        if (APPLY) await prisma.payrollPaymentObligation.update({ where: { idempotencyKey }, data: { amountKopeks: s.amount, paidKopeks: s.paid, remainingKopeks: remaining, status, dueDate } });
        updated += 1; touched = true;
      } else {
        if (APPLY) await prisma.payrollPaymentObligation.create({ data: { companyId: period.companyId, clubId: period.clubId, legalEntityId: s.legalEntityId, payrollPeriodId: period.id, payrollType: "final_salary", payrollCategory: s.category, amountKopeks: s.amount, paidKopeks: s.paid, remainingKopeks: remaining, dueDate, status, idempotencyKey } });
        created += 1; touched = true;
      }
    }
    if (touched) { periodsTouched += 1; report.push(`  ${period.clubId} ${period.year}-${period.month} (${period.status})`); }
  }

  console.log(`${APPLY ? "APPLIED" : "DRY-RUN"} — periods=${periods.length}, touched=${periodsTouched}, created=${created}, updated=${updated}, skipped=${skipped}`);
  if (report.length) console.log("Периоды:\n" + report.join("\n"));
  if (!APPLY) console.log("\nПовторите с --apply, чтобы записать обязательства.");
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
