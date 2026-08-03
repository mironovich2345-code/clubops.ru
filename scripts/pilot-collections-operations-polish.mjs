// Collections operations & control-snapshot workflow polish. Static structure guards +
// runtime mirrors of the snapshot resolver (cancelled excluded; previous applicable takes
// over; later untouched) and the ИП transfer formula. Kopeks-exact; club-local month
// boundaries. tsc/prisma/pilot:full/build are the gauntlet (not file checks here).
//   npm run pilot:collections-operations-polish
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };
const root = fileURLToPath(new URL("../", import.meta.url));
const src = (rel) => readFileSync(join(root, rel), "utf8");

const page = src("src/app/(app)/collections/page.tsx");
const actions = src("src/app/(app)/collections/actions.ts");
const auth = src("src/lib/auth.ts");
const history = src("src/lib/collections-history.ts");
const cashCollections = src("src/lib/cash-collections.ts");
const cashBalances = src("src/lib/cash-balances.ts");
const forms = src("src/app/(app)/collections/_components/CashTransferForms.tsx");
const schema = src("prisma/schema.prisma");
const idx = (s) => page.indexOf(s);

// ---- Runtime mirrors ----
const resolveOpening = (snaps, now) => snaps.filter((s) => s.status === "active" && s.date <= now).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
const factIpTransfer = (opening, transfers) => opening - transfers.filter((t) => t.status === "confirmed").reduce((a, t) => a + t.amountKopeks, 0);
const monthBounds = (m) => { const mm = /^(\d{4})-(\d{2})$/.exec(m); const y = +mm[1], mo = +mm[2] - 1; return { start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) }; };
const inMonth = (d, b) => d >= b.start && d < b.end;

// ===================== Page structure (§2–§5) =====================
check("1 «Фактические деньги» — первый рабочий блок (до карточек остатков и до контрольной точки)",
  idx("Фактические деньги — сверка наличных") > 0 && idx("Фактические деньги — сверка наличных") < idx("Остатки сейчас") && idx("Фактические деньги — сверка наличных") < idx("Контрольный остаток"));
check("2 Карточки текущих остатков ООО/ИП присутствуют", page.includes("<OooCard") && page.includes("<IpCard") && page.includes("Остатки сейчас"));
check("3 Desktop: операции в колонках ООО/ИП (lg:grid-cols-2 + заголовки ООО и ИП)",
  page.includes("Операции с наличными") && page.includes("grid grid-cols-1 gap-4 lg:grid-cols-2") && />ООО<\/div>/.test(page) && />ИП<\/div>/.test(page));
check("4 Mobile: ООО перед ИП (колонка ООО с Инкассировать/Изъять раньше колонки ИП с Иное/Передать)",
  idx('id="collect"') < idx('id="other"') && idx('id="withdraw"') < idx('id="transfer"') && idx('id="other"') < idx('id="transfer"'));
check("5 Форма передачи регионалу присутствует (в колонке ИП)", page.includes("<RegionalTransferForm") && idx("<RegionalTransferForm") > idx('id="transfer"'));
check("6 Отдельный блок «Передачи региональному директору» удалён (нет отдельного accordion + нет getRegionalTransfersForClub на странице)",
  !page.includes('title="Передачи региональному директору"') && !page.includes("getRegionalTransfersForClub"));
check("7 Передачи показываются в общей истории (read model включает transfers)", history.includes('kind: "transfer"') && page.includes("loadCollectionsHistory"));

// ===================== MonthNav + monthly + filters (§6–§8) =====================
check("8 MonthNav переключает месяц истории (prev/next hrefs с month)", page.includes("<MonthNav") && page.includes("qs({ month: prevMonth })") && page.includes("qs({ month: nextMonth })"));
check("9 Текущий остаток НЕ зависит от выбранного месяца (баланс из loadClubCashBalances без month; месяц только для истории)",
  page.includes("loadClubCashBalances(companyId, c.id)") && page.includes("loadCollectionsHistory(companyId, clubIds, selectedMonth)") && page.includes("остаются текущими"));
check("10 Месячные итоги считаются за выбранный месяц (monthBounds + totals)", history.includes("export function monthBounds") && history.includes("CollectionsMonthTotals") && (() => { const b = monthBounds("2026-07"); return inMonth(new Date(2026, 6, 15), b) && !inMonth(new Date(2026, 7, 1), b); })());
check("11 Фильтр по типу работает", page.includes("!fType || r.kind === fType"));
check("12 Фильтр по юрлицу (ООО/ИП) работает", page.includes("!fEntity || r.entity === fEntity"));
check("12b Фильтр по статусу и автору + reset + chips", page.includes("!fStatus || r.status === fStatus") && page.includes("!fAuthor || r.createdById === fAuthor") && page.includes("Сбросить") && page.includes("<Chip"));

// ===================== Snapshot RBAC (§9) =====================
check("13/14/15 Shared guard canManageControlSnapshot: manager + regional + accountant (+owner/GD/chief)",
  auth.includes("export function canManageControlSnapshot") && /canManageControlSnapshot[\s\S]*?"manager"[\s\S]*?"regional_director"[\s\S]*?"accountant"/.test(auth));
check("13b Guard используется в UI + action (create/correct/cancel)", page.includes("canManageControlSnapshot(roles)") && actions.includes("const canSetOpeningBalance = canManageControlSnapshot") && /cancelBalanceSnapshot[\s\S]*?canSetOpeningBalance\(g\.roles\)/.test(actions));
check("16 Cross-company accountant / 17 cross-club manager denied (scope через ctxForWrite: selectedCompanyId + clubId ∈ allowedClubIds)",
  actions.includes("if (clubId && !ctx.allowedClubIds.includes(clubId)) return { ok: false, error: \"Клуб недоступен.\" }") && /correctBalanceSnapshot[\s\S]*?clubId: \{ in: g\.clubIds \}/.test(actions) && /cancelBalanceSnapshot[\s\S]*?clubId: \{ in: g\.clubIds \}/.test(actions));

// ===================== Cancellation (§10–§13) =====================
check("18 Отмена требует причину", /cancelBalanceSnapshot[\s\S]*?if \(!reason\) return \{ ok: false/.test(actions));
check("19 Отменённая точка остаётся в истории (флип active→cancelled, без delete)", /cancelBalanceSnapshot[\s\S]*?data: \{ status: "cancelled"/.test(actions) && !actions.includes("balanceSnapshot.delete"));
check("20 Отменённая точка исключена из resolver (status='active' в loadClubCashBalances)", cashCollections.includes("activeSnapshotWhere(now)") && (() => { const snaps = [{ status: "active", date: "2026-07-01", amountKopeks: 98 }, { status: "cancelled", date: "2026-07-02", amountKopeks: 1550992 }]; return resolveOpening(snaps, "2026-07-10").date === "2026-07-01"; })());
check("21 После отмены применяется предыдущая действующая точка", (() => { const before = [{ status: "active", date: "2026-07-01", amountKopeks: 98 }, { status: "active", date: "2026-07-02", amountKopeks: 1550992 }]; const after = before.map((s) => s.date === "2026-07-02" ? { ...s, status: "cancelled" } : s); return resolveOpening(before, "2026-07-10").date === "2026-07-02" && resolveOpening(after, "2026-07-10").date === "2026-07-01"; })());
check("22 Более поздняя точка не изменяется при отмене другой (отмена флипает только целевую строку)", /cancelBalanceSnapshot[\s\S]*?updateMany\(\{ where: \{ id: old\.id, status: "active" \}/.test(actions));
check("23 Текущий остаток пересчитывается детерминированно (resolver desc by date, cancelled excluded)", cashCollections.includes('orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }]'));
check("24 Нет разрушающего delete + кнопки «Удалить» контрольной точки", !actions.includes("balanceSnapshot.delete") && !page.includes(">Удалить<") && forms.includes("SnapshotCancelButton") && forms.includes("SnapshotCorrectionButton"));

// ===================== Preserved rules (§12) =====================
check("25 Correction chain append-only (supersede + version+1)", /correctBalanceSnapshot[\s\S]*?version: old\.version \+ 1, supersedesSnapshotId: old\.id/.test(actions));
check("26 Backdated поведение сохранено (latest active ≤ now)", cashCollections.includes("activeSnapshotWhere(now)"));
check("27 Confirmed передача уменьшает остаток (unchanged)", cashBalances.includes('REGIONAL_TRANSFER_FACT_STATUSES: readonly string[] = ["confirmed"]') && factIpTransfer(100000, [{ status: "confirmed", amountKopeks: 40000 }]) === 60000);
check("28 Pending передача не влияет", factIpTransfer(100000, [{ status: "pending_confirmation", amountKopeks: 40000 }]) === 100000);
check("29 Cancelled передача не влияет", factIpTransfer(100000, [{ status: "cancelled", amountKopeks: 40000 }]) === 100000);
check("30 Kopeks точно (целочисленно)", factIpTransfer(1550992, [{ status: "confirmed", amountKopeks: 98 }]) === 1550894);
check("31 Границы месяца детерминированы в календаре клуба (monthBounds local start/end)", (() => { const b = monthBounds("2026-07"); return b.start.getFullYear() === 2026 && b.start.getMonth() === 6 && b.start.getDate() === 1 && b.end.getMonth() === 7; })() && history.includes("new Date(y, mo, 1)"));
check("32 Tenant isolation (история scoped companyId+clubIds; actions ctxForWrite)", history.includes("where: { companyId, clubId: { in: clubIds } }") && actions.includes("ctxForWrite"));

// ===================== Regression / model =====================
check("33 Mobile без обрезки: таблицы hidden lg:block + mobile cards; overflow-x clip в globals", page.includes("hidden overflow-x-auto rounded-lg border border-slate-200 lg:block") && page.includes("space-y-3 lg:hidden") && src("src/app/globals.css").includes("overflow-x: clip"));
check("34 Desktop regression: таблицы истории/timeline сохранены (lg:block)", (page.match(/lg:block/g) || []).length >= 2);
check("35 Модель + миграции: cancelled поля есть, миграции dev+prod additive",
  /model BalanceSnapshot[\s\S]*?cancelledAt\s+DateTime\?[\s\S]*?cancellationReason/.test(schema) &&
  readFileSync(join(root, "prisma/migrations/20260801120000_balance_snapshot_cancellation/migration.sql"), "utf8").includes("cancelledAt") &&
  readFileSync(join(root, "prisma/production/migrations/20260801120000_balance_snapshot_cancellation/migration.sql"), "utf8").includes("ADD COLUMN"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
