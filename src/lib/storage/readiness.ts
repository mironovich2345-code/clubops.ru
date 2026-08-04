// Storage readiness (REM-04 §23/§24). Two layers, deliberately separated:
//
//  1. CONFIG readiness (sync, no I/O): is the provider correctly configured for
//     this environment? This is what gates traffic together with the DB — a
//     production instance with `local` storage or an incomplete S3 config is NOT
//     ready. Startup fail-fast (assertStorageConfigured) already refuses to boot
//     such an instance; this gives the readiness endpoint the same verdict.
//
//  2. CONNECTIVITY probe (async, bounded I/O): can we actually reach the bucket?
//     A safe HEAD/list under a dedicated health prefix with a timeout. It is
//     OPTIONAL and NEVER mutates a business object. A transient probe failure is
//     "degraded", not a reason to crash the process after startup.
//
// Value-free: results carry codes/booleans, never a bucket name, endpoint, key or
// object content.

import { resolveStorageConfig } from "./config";
import { getStorage } from "./index";

export type StorageReadiness = {
  ready: boolean;
  provider: "local" | "s3";
  errors: string[];
};

/** Sync config-level readiness — no network. */
export function storageReadiness(): StorageReadiness {
  const v = resolveStorageConfig();
  return { ready: v.ok, provider: v.provider, errors: v.errors };
}

export type StorageProbe = {
  ok: boolean;
  provider: "local" | "s3";
  reachable: boolean;
  code: string; // "ok" | "config" | "unreachable" | "timeout"
};

const HEALTH_PREFIX = "_health";

/**
 * Bounded connectivity probe. Does a read-only `list` under a health prefix (no
 * writes, no business file touched). Resolves to a value-free status; never
 * throws. `timeoutMs` bounds the whole check.
 */
export async function probeStorage(timeoutMs = 3000): Promise<StorageProbe> {
  const cfg = storageReadiness();
  if (!cfg.ready) return { ok: false, provider: cfg.provider, reachable: false, code: "config" };

  const storage = getStorage();
  if (typeof storage.list !== "function") {
    // No probe capability → fall back to config-only readiness.
    return { ok: true, provider: cfg.provider, reachable: false, code: "ok" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StorageProbe>((res) => {
    timer = setTimeout(() => res({ ok: false, provider: cfg.provider, reachable: false, code: "timeout" }), timeoutMs);
  });
  const probe = (async (): Promise<StorageProbe> => {
    try {
      await storage.list!(HEALTH_PREFIX, { max: 1 });
      return { ok: true, provider: cfg.provider, reachable: true, code: "ok" };
    } catch {
      return { ok: false, provider: cfg.provider, reachable: false, code: "unreachable" };
    }
  })();

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
