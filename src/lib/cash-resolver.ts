// REM-02 — the SINGLE official entry point for "the current cash balance of a club/entity". Wraps the
// ratified canonical contour (loadClubCashBalances → calculateCashBalances) and the shared snapshot rule
// so dashboard, collections, analytics, guards, reports and diagnostics all return ONE number. No local
// copies of the formula. Money = integer kopeks. The LEGACY CashWallet balance is NOT consulted here.
import { loadClubCashBalances } from "@/lib/cash-collections";
import { CASH_FORMULA_VERSION } from "@/lib/cash-snapshot-resolver";

export type CashEntityBalance = {
  entityType: "ooo" | "ip";
  legalEntityId: string | null;
  balanceKopeks: number;
  snapshotSet: boolean;
  snapshotDate: Date | null;
  snapshotKopeks: number;
  ofdSinceKopeks: number;
  warnings: string[];
};

export type ResolvedCashBalance = {
  clubId: string;
  asOf: Date;
  calculatedAt: Date;
  formulaVersion: string;
  ooo: CashEntityBalance;
  ip: CashEntityBalance;
};

/**
 * Official current (or as-of) cash balance for one club — both ООО and ИП. `asOf` defaults to now and
 * is the snapshot cutoff; a warning is added when an entity has no control snapshot (the balance then
 * reflects only movements, never a fabricated opening).
 */
export async function resolveCashBalance(args: { companyId: string; clubId: string; asOf?: Date }): Promise<ResolvedCashBalance> {
  const asOf = args.asOf ?? new Date();
  const { balances, oooId, ipId } = await loadClubCashBalances(args.companyId, args.clubId, asOf);
  const warn = (set: boolean) => (set ? [] : ["Нет контрольной точки — остаток посчитан только по движениям (без стартового значения)."]);
  return {
    clubId: args.clubId,
    asOf,
    calculatedAt: new Date(),
    formulaVersion: CASH_FORMULA_VERSION,
    ooo: {
      entityType: "ooo",
      legalEntityId: oooId,
      balanceKopeks: balances.cashOooFactBalance,
      snapshotSet: balances.cashOooOpeningSet,
      snapshotDate: balances.cashOooOpeningDate ? new Date(balances.cashOooOpeningDate) : null,
      snapshotKopeks: balances.cashOooOpening,
      ofdSinceKopeks: balances.cashOooOfdSinceOpening,
      warnings: warn(balances.cashOooOpeningSet),
    },
    ip: {
      entityType: "ip",
      legalEntityId: ipId,
      balanceKopeks: balances.cashIpFactBalance,
      snapshotSet: balances.cashIpOpeningSet,
      snapshotDate: balances.cashIpOpeningDate ? new Date(balances.cashIpOpeningDate) : null,
      snapshotKopeks: balances.cashIpOpening,
      ofdSinceKopeks: balances.cashIpOfdSinceOpening,
      warnings: warn(balances.cashIpOpeningSet),
    },
  };
}
