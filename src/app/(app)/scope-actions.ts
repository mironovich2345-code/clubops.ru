"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import {
  getCurrentAccessContext,
  getUserCompanies,
  getUserClubs,
  SCOPE_COMPANY_COOKIE,
  SCOPE_CLUB_COOKIE,
} from "@/lib/access";

const ONE_YEAR = 60 * 60 * 24 * 365;
const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: ONE_YEAR } as const;

/**
 * Sets the active company/club scope used by every dashboard and list. An empty
 * clubId means "all clubs in the company" (company-level view).
 *
 * Selection is access-checked here so a stale/forged cookie can never persist;
 * getCurrentCompanyAndClub independently re-validates on read, so the cookie is
 * a view preference, not an authorization grant.
 */
export async function setActiveScope(formData: FormData): Promise<void> {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return;

  const companyId = String(formData.get("companyId") ?? "");
  const clubId = String(formData.get("clubId") ?? "");

  const companies = await getUserCompanies(ctx.user.id);
  const company = companies.find((c) => c.id === companyId);
  if (!company) return;

  const store = await cookies();
  store.set(SCOPE_COMPANY_COOKIE, company.id, COOKIE_OPTS);

  // A club is only honored if it belongs to the chosen company; otherwise the
  // scope falls back to all clubs (e.g. a stale club after switching company).
  if (clubId) {
    const clubs = await getUserClubs(ctx.user.id, company.id);
    if (clubs.some((c) => c.id === clubId)) {
      store.set(SCOPE_CLUB_COOKIE, clubId, COOKIE_OPTS);
    } else {
      store.delete(SCOPE_CLUB_COOKIE);
    }
  } else {
    store.delete(SCOPE_CLUB_COOKIE);
  }

  revalidatePath("/", "layout");
}
