// Shared helper that turns the strategic URL filters into a per-Company grouping
// for the analytical pages (Analytics / Expenses / Invoices / Payments). Every
// page reuses resolveStrategicScope (one filter architecture) and then loads each
// Company's existing scoped dataset with ONLY that Company's club ids — financial
// metrics (balances, cash gaps) are kept isolated per Company, never merged.
import type { AccessContext } from "@/lib/access";
import { resolveStrategicScope, type StrategicAccessScope } from "@/lib/strategic-scope";

export type StrategicGroup = { companyId: string; companyName: string; clubIds: string[] };

export type StrategicGroups = {
  scope: StrategicAccessScope;
  multiCompany: boolean;
  /** Filtered clubs grouped by Company — one scoped loader call per group. */
  byCompany: StrategicGroup[];
  filteredCompanyIds: string[];
  filteredClubIds: string[];
  companyNameById: Map<string, string>;
};

export type StrategicPageParams = {
  scopeMode?: string;
  companyId?: string;
  city?: string;
  clubId?: string;
};

export async function resolveStrategicGroups(ctx: AccessContext, params: StrategicPageParams): Promise<StrategicGroups> {
  const scope = await resolveStrategicScope(ctx, params);
  const map = new Map<string, { name: string; clubIds: string[] }>();
  for (const c of scope.filteredClubs) {
    const g = map.get(c.companyId) ?? { name: c.companyName, clubIds: [] };
    g.clubIds.push(c.id);
    map.set(c.companyId, g);
  }
  const byCompany: StrategicGroup[] = [...map.entries()]
    .map(([companyId, g]) => ({ companyId, companyName: g.name, clubIds: g.clubIds }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName, "ru"));
  return {
    scope,
    multiCompany: scope.filteredCompanyIds.length > 1,
    byCompany,
    filteredCompanyIds: scope.filteredCompanyIds,
    filteredClubIds: scope.filteredClubs.map((c) => c.id),
    companyNameById: new Map(scope.accessibleCompanies.map((c) => [c.id, c.name])),
  };
}

/**
 * Builds the URL query string preserving strategic filters (+ extra page params).
 * Used by page-specific filter forms so changing a category/status/period keeps
 * the active Company/City/Club/month.
 */
export function strategicQuery(scope: StrategicAccessScope, month: string | null, extra?: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  p.set("scopeMode", scope.mode);
  if (scope.selectedCompanyId) p.set("companyId", scope.selectedCompanyId);
  if (scope.selectedCity) p.set("city", scope.selectedCity);
  if (scope.selectedClubId) p.set("clubId", scope.selectedClubId);
  if (month) p.set("month", month);
  for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
  return p.toString();
}
