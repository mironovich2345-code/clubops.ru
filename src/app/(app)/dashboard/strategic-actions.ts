"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, canAccessCompany, canAccessClub } from "@/lib/access";
import { isStrategicRole } from "@/lib/auth";
import { setActiveScope } from "@/app/(app)/scope-actions";

// Strategic-filter keys that may be carried back to an analytical page. Anything
// else in the return string is dropped (the result is only ever a query string
// appended to a fixed internal path — never an open redirect).
const RETURN_KEYS = [
  "scopeMode", "companyId", "city", "clubId", "month", "category", "status", "source", "legalEntity", "pay", "entity", "period", "from", "to", "back",
];
function safeReturn(raw: string): string {
  if (!raw) return "";
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  } catch {
    return "";
  }
  const out = new URLSearchParams();
  for (const k of RETURN_KEYS) {
    const v = p.get(k);
    if (v) out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/**
 * Safe context-switch-and-open for a strategic Expense / Invoice row that may
 * belong to a Company other than the active-scope cookie. Verifies (1) the actor
 * is a strategic role, (2) explicit Company + Club access, (3) the RECORD really
 * belongs to that Company/Club, then sets scope and redirects to the allowlisted
 * detail route (preserving safe return filters). The detail page still performs
 * its own object-level authorization; the cookie never grants access.
 */
async function openStrategicRecord(kind: "expense" | "invoice", formData: FormData): Promise<void> {
  const base = kind === "expense" ? "/expenses" : "/invoices";
  const ctx = await getCurrentAccessContext();
  const ret = safeReturn(String(formData.get("returnTo") ?? ""));
  if (!ctx || !isStrategicRole(ctx.effectiveRoles)) redirect(base + ret);

  const companyId = String(formData.get("companyId") ?? "").trim();
  const objectId = String(formData.get("objectId") ?? "").trim();
  if (!companyId || !objectId || !(await canAccessCompany(ctx!.user.id, companyId))) redirect(base + ret);

  const rec =
    kind === "expense"
      ? await prisma.expense.findUnique({ where: { id: objectId }, select: { companyId: true, clubId: true } })
      : await prisma.invoice.findUnique({ where: { id: objectId }, select: { companyId: true, clubId: true } });
  // The record must belong to the claimed Company, and the Club must be accessible.
  if (!rec || rec.companyId !== companyId) redirect(base + ret);
  if (!(await canAccessClub(ctx!.user.id, rec.clubId))) redirect(base + ret);

  await setActiveScope(companyId, rec.clubId);
  redirect(`${base}/${encodeURIComponent(objectId)}${ret}`);
}

export async function openStrategicExpense(formData: FormData): Promise<void> {
  await openStrategicRecord("expense", formData);
}

export async function openStrategicInvoice(formData: FormData): Promise<void> {
  await openStrategicRecord("invoice", formData);
}

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
