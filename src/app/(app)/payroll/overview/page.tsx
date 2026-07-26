import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Backward-compat (spec §15): the standalone "Обзор" is gone — its KPIs live in the main
// screen header. /payroll/overview forwards to /payroll, preserving month/club.
export default async function PayrollOverviewRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v) params.set(k, v);
  }
  const q = params.toString();
  redirect(`/payroll${q ? `?${q}` : ""}`);
}
