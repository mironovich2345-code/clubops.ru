// Pure aggregation for the ОФД-продажи analytics view. No I/O, no secrets, no raw
// fiscal data — operates ONLY on already-safe projections of OfdDailySalesSummary /
// OfdRevenueCategoryDailySummary / OfdReceiptItem. Deterministic and fully testable.

export type OfdSalesDay = {
  clubId: string;
  legalEntityId: string | null;
  date: string; // "YYYY-MM-DD"
  incomeTotalKopeks: number;
  incomeCashKopeks: number;
  incomeElectronicKopeks: number;
  returnTotalKopeks: number;
  netTotalKopeks: number;
  receiptCount: number;
  returnReceiptCount: number;
};

export type OfdMoneyAgg = {
  income: number;
  cash: number;
  electronic: number;
  ret: number;
  net: number;
  receipts: number;
  returnReceipts: number;
};

export function emptyAgg(): OfdMoneyAgg {
  return { income: 0, cash: 0, electronic: 0, ret: 0, net: 0, receipts: 0, returnReceipts: 0 };
}

function accumulate(a: OfdMoneyAgg, s: OfdSalesDay): void {
  a.income += s.incomeTotalKopeks;
  a.cash += s.incomeCashKopeks;
  a.electronic += s.incomeElectronicKopeks;
  a.ret += s.returnTotalKopeks;
  a.net += s.netTotalKopeks;
  a.receipts += s.receiptCount;
  a.returnReceipts += s.returnReceiptCount;
}

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

/** Single total across [from,to] inclusive (string date compare, YYYY-MM-DD). */
export function totalForRange(rows: OfdSalesDay[], from: string, to: string): OfdMoneyAgg {
  const a = emptyAgg();
  for (const s of rows) if (inRange(s.date, from, to)) accumulate(a, s);
  return a;
}

/** Per-club aggregate for [from,to]. */
export function aggByClub(rows: OfdSalesDay[], from: string, to: string): Map<string, OfdMoneyAgg> {
  const m = new Map<string, OfdMoneyAgg>();
  for (const s of rows) {
    if (!inRange(s.date, from, to)) continue;
    const a = m.get(s.clubId) ?? emptyAgg();
    accumulate(a, s);
    m.set(s.clubId, a);
  }
  return m;
}

/** Per-legal-entity aggregate for [from,to]. Key = legalEntityId ?? "none". */
export function aggByLegalEntity(rows: OfdSalesDay[], from: string, to: string): Map<string, OfdMoneyAgg> {
  const m = new Map<string, OfdMoneyAgg>();
  for (const s of rows) {
    if (!inRange(s.date, from, to)) continue;
    const key = s.legalEntityId ?? "none";
    const a = m.get(key) ?? emptyAgg();
    accumulate(a, s);
    m.set(key, a);
  }
  return m;
}

// --- Revenue categories (fixed CLUB-OPS order) -----------------------------
export const OFD_ANALYTICS_CATEGORY_ORDER = ["membership", "personal_training", "group_training", "extra_services", "other"] as const;
export const OFD_ANALYTICS_CATEGORY_NAMES: Record<string, string> = {
  membership: "Абонементы",
  personal_training: "Персональные тренировки",
  group_training: "Групповые тренировки",
  extra_services: "Доп. услуги",
  other: "Иное",
};

export type OfdCategoryDay = {
  categoryCode: string;
  incomeTotalKopeks: number;
  returnTotalKopeks: number;
  netTotalKopeks: number;
  itemCount: number;
  receiptCount: number;
};
export type OfdCategoryRow = { code: string; name: string; income: number; ret: number; net: number; items: number; receipts: number };

/** Aggregate category-day rows into the fixed-order category table (only present codes). */
export function aggCategories(rows: OfdCategoryDay[]): OfdCategoryRow[] {
  const agg = new Map<string, { income: number; ret: number; net: number; items: number; receipts: number }>();
  for (const s of rows) {
    const a = agg.get(s.categoryCode) ?? { income: 0, ret: 0, net: 0, items: 0, receipts: 0 };
    a.income += s.incomeTotalKopeks;
    a.ret += s.returnTotalKopeks;
    a.net += s.netTotalKopeks;
    a.items += s.itemCount;
    a.receipts += s.receiptCount;
    agg.set(s.categoryCode, a);
  }
  return OFD_ANALYTICS_CATEGORY_ORDER.filter((c) => agg.has(c)).map((code) => ({ code, name: OFD_ANALYTICS_CATEGORY_NAMES[code], ...agg.get(code)! }));
}

// --- Category drilldown detail (safe: normalized name + <=3 example names) --
export type OfdReceiptItemProjection = {
  revenueCategoryCode: string;
  normalizedItemName: string;
  itemName: string;
  totalKopeks: number;
  operationType: string;
  receiptImportId: string;
};
export type OfdCategoryDetailRow = { normalizedName: string; net: number; income: number; itemCount: number; receiptCount: number; examples: string[] };

/** Group receipt items by (categoryCode, normalizedItemName) → drilldown rows.
 * Only SAFE fields: normalized names, up to 3 example item names (≤160 chars),
 * money and counts. Never raw fiscal data or personal data. */
export function buildCategoryDetails(items: OfdReceiptItemProjection[]): Record<string, OfdCategoryDetailRow[]> {
  const byCat = new Map<string, Map<string, { income: number; ret: number; itemCount: number; receipts: Set<string>; examples: string[]; seen: Set<string> }>>();
  for (const it of items) {
    let cat = byCat.get(it.revenueCategoryCode);
    if (!cat) { cat = new Map(); byCat.set(it.revenueCategoryCode, cat); }
    let row = cat.get(it.normalizedItemName);
    if (!row) { row = { income: 0, ret: 0, itemCount: 0, receipts: new Set(), examples: [], seen: new Set() }; cat.set(it.normalizedItemName, row); }
    if (it.operationType === "income") row.income += it.totalKopeks; else row.ret += it.totalKopeks;
    row.itemCount += 1;
    row.receipts.add(it.receiptImportId);
    const ex = (it.itemName ?? "").slice(0, 160);
    if (ex && !row.seen.has(ex) && row.examples.length < 3) { row.examples.push(ex); row.seen.add(ex); }
  }
  const out: Record<string, OfdCategoryDetailRow[]> = {};
  for (const [code, rows] of byCat) {
    out[code] = [...rows.entries()]
      .map(([normalizedName, r]) => ({ normalizedName, net: r.income - r.ret, income: r.income, itemCount: r.itemCount, receiptCount: r.receipts.size, examples: r.examples }))
      .sort((a, b) => b.net - a.net);
  }
  return out;
}

// --- Month helpers (local calendar, no UTC drift) --------------------------
/** "YYYY-MM-DD" for a local date. */
export function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Current month "YYYY-MM" (local). */
export function currentMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
/** Shift a "YYYY-MM" by delta months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
/** A valid month for the picker: a well-formed month, never in the future. */
export function clampMonth(month: string | undefined, current: string): string {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return current;
  return month > current ? current : month;
}
/** First/last day strings for a "YYYY-MM" ("-31" upper bound is string-compare-safe). */
export function monthBounds(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-31` };
}

// --- Dashboard overview (managerial ОФД snapshot) --------------------------
// A compact, fully-pure summary for the main dashboard block. Consumes the same
// SAFE projections as the analytics page (OfdDailySalesSummary / category-day
// rows). Never touches raw fiscal data, secrets or personal data.
export type OfdClubRow = { clubId: string; name: string; agg: OfdMoneyAgg; avgCheckKopeks: number };
export type OfdLegalRow = { legalEntityId: string; name: string; agg: OfdMoneyAgg };
export type OfdCategoryShareRow = OfdCategoryRow & { share: number };
export type OfdMonthPace = { avgPerDayKopeks: number; forecastKopeks: number; daysPassed: number; daysLeft: number; daysInMonth: number };
export type OfdAttentionSignal = { code: string; message: string };
export type OfdDashboardOverview = {
  today: OfdMoneyAgg;
  yesterday: OfdMoneyAgg;
  month: OfdMoneyAgg;
  pace: OfdMonthPace;
  byClub: OfdClubRow[];
  byLegal: OfdLegalRow[];
  categories: OfdCategoryShareRow[];
  otherShare: number; // «Иное» income / month income (0..1)
  otherWarn: boolean; // soft warning threshold (> 5%)
  signals: OfdAttentionSignal[];
  hasData: boolean;
};

export type OfdDashboardInput = {
  summaries: OfdSalesDay[];
  categoryDays: OfdCategoryDay[];
  clubNameById: Record<string, string>;
  legalNameById: Record<string, string>;
  today: string; // "YYYY-MM-DD"
  yesterday: string;
  monthFrom: string; // "YYYY-MM-01"
  monthTo: string; // "YYYY-MM-31"
  daysInMonth: number;
  daysPassed: number; // 1..daysInMonth for the live month
  nowHour: number; // 0..23 — used to soften the "no sales today" signal
  lastSyncFailed: boolean;
};

const OTHER_WARN_SHARE = 0.05; // soft "проверьте номенклатуру" hint on the category block
const OTHER_SIGNAL_SHARE = 0.1; // «Требует внимания» signal
const RETURNS_SIGNAL_SHARE = 0.05; // returns > 5% of month income
const AFTERNOON_HOUR = 12; // only warn about "no sales today" once the day is well underway

const avgCheck = (a: OfdMoneyAgg) => (a.receipts > 0 ? Math.round(a.net / a.receipts) : 0);

/** Build the managerial ОФД dashboard overview. Pure + deterministic. */
export function buildOfdDashboardOverview(input: OfdDashboardOverviewInput): OfdDashboardOverview {
  const { summaries, categoryDays, clubNameById, legalNameById, today, yesterday, monthFrom, monthTo } = input;
  const todayAgg = totalForRange(summaries, today, today);
  const yesterdayAgg = totalForRange(summaries, yesterday, yesterday);
  const monthAgg = totalForRange(summaries, monthFrom, monthTo);

  const byClub: OfdClubRow[] = [...aggByClub(summaries, monthFrom, monthTo).entries()]
    .map(([clubId, agg]) => ({ clubId, name: clubNameById[clubId] ?? "—", agg, avgCheckKopeks: avgCheck(agg) }))
    .sort((a, b) => b.agg.income - a.agg.income); // приход убывание

  const byLegal: OfdLegalRow[] = [...aggByLegalEntity(summaries, monthFrom, monthTo).entries()]
    .map(([key, agg]) => ({ legalEntityId: key, name: key === "none" ? "Без юрлица" : legalNameById[key] ?? "—", agg }))
    .sort((a, b) => b.agg.income - a.agg.income);

  const catRows = aggCategories(categoryDays);
  const catIncome = catRows.reduce((s, c) => s + c.income, 0);
  const categories: OfdCategoryShareRow[] = catRows.map((c) => ({ ...c, share: catIncome > 0 ? c.income / catIncome : 0 }));
  const otherIncome = catRows.find((c) => c.code === "other")?.income ?? 0;
  const otherShare = catIncome > 0 ? otherIncome / catIncome : 0;

  const daysPassed = Math.max(0, input.daysPassed);
  const daysInMonth = Math.max(1, input.daysInMonth);
  const avgPerDayKopeks = daysPassed > 0 ? Math.round(monthAgg.income / daysPassed) : 0;
  const pace: OfdMonthPace = {
    avgPerDayKopeks,
    forecastKopeks: avgPerDayKopeks * daysInMonth,
    daysPassed,
    daysLeft: Math.max(0, daysInMonth - daysPassed),
    daysInMonth,
  };

  // --- «Требует внимания» — simple rule-based managerial signals -------------
  const signals: OfdAttentionSignal[] = [];
  if (input.lastSyncFailed) {
    signals.push({ code: "sync_failed", message: "ОФД-синхронизация завершилась с ошибкой. Проверьте подключение." });
  }
  if (todayAgg.receipts === 0 && monthAgg.receipts > 0 && input.nowHour >= AFTERNOON_HOUR) {
    signals.push({ code: "no_sales_today", message: "Сегодня пока нет продаж по ОФД. Если клубы работают — проверьте синхронизацию." });
  }
  if (otherShare > OTHER_SIGNAL_SHARE) {
    signals.push({ code: "other_high", message: `Большая доля выручки в «Иное» (${Math.round(otherShare * 100)}%) — проверьте номенклатуру.` });
  }
  if (monthAgg.income > 0 && monthAgg.ret / monthAgg.income > RETURNS_SIGNAL_SHARE) {
    signals.push({ code: "returns_high", message: `Возвраты за месяц превышают ${Math.round(RETURNS_SIGNAL_SHARE * 100)}% от прихода — проверьте причины.` });
  }
  // Club with month sales but nothing yesterday — only when the network DID sell
  // yesterday (so we know the sync ran and it is not simply a missing-data day).
  if (yesterdayAgg.receipts > 0) {
    const yByClub = aggByClub(summaries, yesterday, yesterday);
    for (const c of byClub) {
      if (c.agg.receipts > 0 && (yByClub.get(c.clubId)?.receipts ?? 0) === 0) {
        signals.push({ code: "club_no_sales_yesterday", message: `По клубу «${c.name}» вчера не было продаж по ОФД.` });
      }
    }
  }

  const hasData = monthAgg.income > 0 || monthAgg.ret > 0 || byClub.length > 0;
  return { today: todayAgg, yesterday: yesterdayAgg, month: monthAgg, pace, byClub, byLegal, categories, otherShare, otherWarn: otherShare > OTHER_WARN_SHARE, signals, hasData };
}
export type OfdDashboardOverviewInput = OfdDashboardInput;
