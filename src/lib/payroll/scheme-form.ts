// Pure form → raw scheme-params mapper (rubles→kopeks, percent→bp). Shared by the
// employee scheme form and the versioned-scheme draft editor. No DB, no "use server".
import { rublesToKopeks } from "@/lib/money";

const rubField = (fd: FormData, name: string): number | null => {
  const raw = String(fd.get(name) ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? rublesToKopeks(n) : null;
};
const pctField = (fd: FormData, name: string): number | null => {
  const raw = String(fd.get(name) ?? "").trim().replace(",", ".");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null; // percent → basis points
};
const numField = (fd: FormData, name: string): number | null => {
  const raw = String(fd.get(name) ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** Map form inputs (rubles / percent) to the raw kopeks/bp params for a scheme type. */
export function collectSchemeRawParams(schemeType: string, fd: FormData): Record<string, unknown> {
  switch (schemeType) {
    case "fixed_salary":
      return { baseKopeks: rubField(fd, "baseRubles") };
    case "salary_by_shifts":
      return { baseKopeks: rubField(fd, "baseRubles"), shiftNorm: numField(fd, "shiftNorm") };
    case "salary_plus_percentage":
      return {
        baseKopeks: rubField(fd, "baseRubles"),
        shiftNorm: numField(fd, "shiftNorm"),
        belowPlanRateBp: pctField(fd, "belowPlanPercent"),
        atPlanRateBp: pctField(fd, "atPlanPercent"),
      };
    case "sales_percentage":
      return { rateBp: pctField(fd, "ratePercent") };
    case "hourly":
      return { hourlyRateKopeks: rubField(fd, "hourlyRateRubles") };
    case "plan_adjusted_salary":
      return {
        subscriptionsBaseKopeks: rubField(fd, "subscriptionsBaseRubles"),
        ptBaseKopeks: rubField(fd, "ptBaseRubles"),
        maxAdjustmentBp: pctField(fd, "maxAdjustmentPercent"),
        manualReviewDeviationBp: pctField(fd, "manualReviewDeviationPercent"),
      };
    case "revenue_percentage":
      return {
        fixedKopeks: rubField(fd, "fixedRubles"),
        subsPercentBp: pctField(fd, "subsPercent"),
        ptPercentBp: pctField(fd, "ptPercent"),
      };
    case "profit_percentage":
      return { percentBp: pctField(fd, "profitPercent") };
    default:
      return {};
  }
}
