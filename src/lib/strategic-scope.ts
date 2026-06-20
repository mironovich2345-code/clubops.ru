// Strategic (owner / general director) cross-Company read-only scope. A user may
// hold access to several Company/network records in the SAME deployment (one
// CompanyUserAccess row per company). This resolver turns the URL filters into a
// validated, access-safe set of Clubs to render on the Dashboard.
//
// Authorization is ALWAYS by explicit access records (getUserCompanies /
// getUserClubs). Query parameters are filters, never authorization: any company /
// city / club value that is not inside the user's accessible set falls back to
// "all". Inaccessible Company/Club names are never disclosed.
import type { AccessContext } from "@/lib/access";
import { getUserCompanies, getUserClubs } from "@/lib/access";

export type StrategicScopeMode = "city" | "company";
export type CompanySummary = { id: string; name: string };
export type ClubSummary = { id: string; name: string; city: string; companyId: string; companyName: string };

export type StrategicAccessScope = {
  accessibleCompanyIds: string[];
  accessibleCompanies: CompanySummary[];
  accessibleClubs: ClubSummary[];
  /** Companies covered by the current filter selection. */
  filteredCompanyIds: string[];
  /** Clubs to render (already access-checked + filtered). */
  filteredClubs: ClubSummary[];
  /** Distinct cities across the accessible clubs (for the dropdown). */
  cities: string[];
  mode: StrategicScopeMode;
  selectedCompanyId: string | null; // null = Все компании
  selectedCity: string | null; // null = Все города
  selectedClubId: string | null; // null = Все клубы
};

export type StrategicScopeParams = {
  scopeMode?: string;
  companyId?: string;
  city?: string;
  clubId?: string;
};

/**
 * Resolves the owner/GD cross-Company Dashboard scope from validated filters.
 * Never trusts the query string for access — only accessible companies/clubs are
 * ever considered, and invalid selections degrade safely to "all".
 */
export async function resolveStrategicScope(
  ctx: AccessContext,
  params: StrategicScopeParams,
): Promise<StrategicAccessScope> {
  const [companies, clubs] = await Promise.all([
    getUserCompanies(ctx.user.id),
    getUserClubs(ctx.user.id), // active clubs across ALL accessible companies
  ]);
  const accessibleCompanies: CompanySummary[] = companies.map((c) => ({ id: c.id, name: c.name }));
  const accessibleCompanyIds = accessibleCompanies.map((c) => c.id);
  const accessibleClubs: ClubSummary[] = clubs.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city ?? "",
    companyId: c.companyId,
    companyName: c.company?.name ?? "",
  }));
  const cities = [...new Set(accessibleClubs.map((c) => c.city).filter((x) => x.length > 0))].sort((a, b) =>
    a.localeCompare(b, "ru"),
  );

  const mode: StrategicScopeMode = params.scopeMode === "company" ? "company" : "city";

  // Company filter: only honoured when accessible; otherwise "all".
  const selectedCompanyId =
    params.companyId && params.companyId !== "all" && accessibleCompanyIds.includes(params.companyId)
      ? params.companyId
      : null;

  // City filter validated against the cities visible under the company selection.
  const cityPool = selectedCompanyId
    ? accessibleClubs.filter((c) => c.companyId === selectedCompanyId)
    : accessibleClubs;
  const selectedCity =
    params.city && params.city !== "all" && cityPool.some((c) => c.city === params.city) ? params.city : null;

  // Apply company + city to get the candidate pool, then validate the club.
  let pool = accessibleClubs;
  if (selectedCompanyId) pool = pool.filter((c) => c.companyId === selectedCompanyId);
  if (selectedCity) pool = pool.filter((c) => c.city === selectedCity);
  const selectedClubId =
    params.clubId && params.clubId !== "all" && pool.some((c) => c.id === params.clubId) ? params.clubId : null;

  const filteredClubs = selectedClubId ? pool.filter((c) => c.id === selectedClubId) : pool;
  const filteredCompanyIds = [...new Set(filteredClubs.map((c) => c.companyId))];

  return {
    accessibleCompanyIds,
    accessibleCompanies,
    accessibleClubs,
    filteredCompanyIds,
    filteredClubs,
    cities,
    mode,
    selectedCompanyId,
    selectedCity,
    selectedClubId,
  };
}
