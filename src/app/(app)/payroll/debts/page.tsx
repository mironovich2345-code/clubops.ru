import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// "Долги" — the manager's secondary section (spec §6). Canonical debts data lives at
// /payroll/obligations (already club-scoped + tested); this route is the stable /payroll/debts
// entry that forwards there, preserving any club/period/status query.
export default async function PayrollDebtsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v) params.set(k, v);
  }
  const q = params.toString();
  redirect(`/payroll/obligations${q ? `?${q}` : ""}`);
}
