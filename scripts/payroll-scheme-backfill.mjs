// STAGE 12 backfill: initialise version/status on existing EmployeePayScheme rows
// (spec §16). DRY-RUN by default — pass --apply to write. Within each logical key
// (company|club|employee?ALL|position) rows are ordered by effectiveFrom then createdAt
// and assigned version 1..N; status is derived by dates:
//   effectiveTo != null            → superseded
//   effectiveFrom in the future     → scheduled
//   otherwise                       → active
// Used-in-snapshot rows keep their business params untouched (only the NEW metadata
// columns are initialised). Ambiguous rows are reported, never guessed.
//   node scripts/payroll-scheme-backfill.mjs            (dry-run)
//   node scripts/payroll-scheme-backfill.mjs --apply    (write)
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const keyOf = (s) => `${s.companyId}|${s.clubId}|${s.employeeId ?? "ALL"}|${s.position ?? ""}`;
const ms = (d) => (d ? new Date(d).getTime() : null);

function statusFor(s, now) {
  if (s.effectiveTo != null) return "superseded";
  if (ms(s.effectiveFrom) > now) return "scheduled";
  return "active";
}

async function main() {
  const now = Date.now();
  const rows = await p.employeePayScheme.findMany({});
  const byKey = new Map();
  for (const s of rows) { const k = keyOf(s); (byKey.get(k) ?? byKey.set(k, []).get(k)).push(s); }

  const plan = [];
  const ambiguous = [];
  for (const [k, list] of byKey) {
    list.sort((a, b) => (ms(a.effectiveFrom) - ms(b.effectiveFrom)) || (ms(a.createdAt) - ms(b.createdAt)));
    // Two rows sharing the same effectiveFrom in one key → cannot order versions safely.
    for (let i = 1; i < list.length; i++) {
      if (ms(list[i].effectiveFrom) === ms(list[i - 1].effectiveFrom)) ambiguous.push({ key: k, ids: [list[i - 1].id, list[i].id] });
    }
    list.forEach((s, i) => {
      const version = i + 1;
      const status = statusFor(s, now);
      const supersedesSchemeId = i > 0 ? list[i - 1].id : null;
      if (s.version !== version || s.status !== status || s.supersedesSchemeId !== supersedesSchemeId) {
        plan.push({ id: s.id, version, status, supersedesSchemeId });
      }
    });
  }

  console.log(`=== payroll:scheme-backfill ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`schemes total     : ${rows.length}`);
  console.log(`logical keys      : ${byKey.size}`);
  console.log(`rows to update    : ${plan.length}`);
  console.log(`ambiguous (skip)  : ${ambiguous.length}`);
  if (ambiguous.length) console.log("AMBIGUOUS (manual review, NOT written):", JSON.stringify(ambiguous.slice(0, 30)));

  if (!APPLY) {
    console.log("Dry-run only. Re-run with --apply to write.");
    await p.$disconnect();
    return;
  }
  // Skip rows in an ambiguous key (never guess). Write the rest.
  const ambiguousIds = new Set(ambiguous.flatMap((a) => a.ids));
  let written = 0;
  for (const u of plan) {
    if (ambiguousIds.has(u.id)) continue;
    await p.employeePayScheme.update({ where: { id: u.id }, data: { version: u.version, status: u.status, supersedesSchemeId: u.supersedesSchemeId } });
    written++;
  }
  console.log(`written           : ${written}`);
  await p.$disconnect();
}
main();
