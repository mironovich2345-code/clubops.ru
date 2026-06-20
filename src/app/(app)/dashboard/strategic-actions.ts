"use server";

import { redirect } from "next/navigation";
import { getCurrentAccessContext, canAccessCompany, canAccessClub } from "@/lib/access";
import { setActiveScope } from "@/app/(app)/scope-actions";

// Allowlisted internal destinations only — never an arbitrary redirect URL.
const DESTINATIONS: Record<string, (id: string) => string> = {
  sales_report: (id) => `/sales/reports/${encodeURIComponent(id)}`,
  expense: (id) => `/expenses/${encodeURIComponent(id)}`,
  invoice: (id) => `/invoices/${encodeURIComponent(id)}`,
  club_analytics: () => `/analytics`,
};

/**
 * Safe context-switch-and-open for the strategic (multi-Company) dashboard. A
 * card/row may belong to a Company other than the active-scope cookie. This:
 *   1. re-validates access to the target Company (and Club, if given),
 *   2. sets the active scope via the existing access-checked helper,
 *   3. redirects to an ALLOWLISTED internal destination.
 * Changing the cookie never grants access — the destination page still performs
 * its own object-level authorization.
 */
export async function openInStrategicScope(formData: FormData): Promise<void> {
  const target = String(formData.get("target") ?? "").trim();
  const companyId = String(formData.get("companyId") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  const objectId = String(formData.get("objectId") ?? "").trim();

  const build = DESTINATIONS[target];
  const ctx = await getCurrentAccessContext();
  if (!ctx || !build) redirect("/dashboard");

  // Independent access checks — query params are not authorization.
  if (!companyId || !(await canAccessCompany(ctx!.user.id, companyId))) redirect("/dashboard");
  if (clubId && !(await canAccessClub(ctx!.user.id, clubId))) redirect("/dashboard");

  await setActiveScope(companyId, clubId);
  redirect(build!(objectId));
}
