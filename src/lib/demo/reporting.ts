import { isDemo } from "./config";

// Only read-side reporting uses this historical clock. Auth, TTL and writes
// always use real time. The toolbar states the historical cutoff explicitly.
export function reportingNow(): Date {
  return isDemo() ? new Date(2026, 10, 15, 23, 59, 59) : new Date();
}

export function reportingRevenue(figures: { incomeKopeks: number; netKopeks: number } | undefined): number {
  return figures ? (isDemo() ? figures.netKopeks : figures.incomeKopeks) : 0;
}
