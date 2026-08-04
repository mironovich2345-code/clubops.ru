// REM-06 — shared health/readiness result model. Every check returns this shape;
// API responses carry ONLY these fields (no raw errors, no secrets, no hosts).

export type DependencyStatus = "ok" | "degraded" | "failed" | "unknown";

export type DependencyCheckResult = {
  name: string;
  status: DependencyStatus;
  requiredForReadiness: boolean;
  latencyMs: number | null;
  checkedAt: string; // ISO
  errorCode?: string; // machine code, secret-free
  safeMessage?: string; // human, secret-free
  metadata?: Record<string, string | number | boolean | null>; // safe-only
};

export type ReadinessVerdict = {
  status: "ready" | "not_ready";
  ready: boolean;
  checks: DependencyCheckResult[];
};

export type DependenciesReport = {
  overall: DependencyStatus;
  checks: DependencyCheckResult[];
};

export function worstStatus(checks: DependencyCheckResult[]): DependencyStatus {
  if (checks.some((c) => c.status === "failed")) return "failed";
  if (checks.some((c) => c.status === "degraded")) return "degraded";
  if (checks.some((c) => c.status === "unknown")) return "unknown";
  return "ok";
}
