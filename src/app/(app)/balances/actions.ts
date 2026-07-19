"use server";

import { auditBlockedFeature } from "@/lib/disabled-features";

type State = { ok: boolean; error?: string };

/**
 * Legacy /balances writer — DISABLED. Control (opening) balances are now set ONLY via
 * Финансы → Инкассация (/collections) `setCashOpeningBalance`, which is the single
 * writer of the BalanceSnapshot control checkpoint the fact-balance engine reads.
 * Even a direct call is refused here, so no BalanceSnapshot can be created from the
 * legacy /balances flow. Historical snapshots and the /collections checkpoint are
 * untouched (no hard delete).
 */
export async function createBalanceSnapshot(_prev: State | undefined, _formData: FormData): Promise<State> {
  await auditBlockedFeature("balance_snapshot.create");
  return { ok: false, error: "Legacy /balances disabled. Use /collections." };
}
