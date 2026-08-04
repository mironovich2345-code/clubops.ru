// REM-06 — short in-memory cache + single-flight for health probes. Health
// endpoints are polled frequently (load balancers, orchestrators); this bounds the
// real work to at most one probe per TTL and coalesces concurrent callers.
//
// IMPORTANT: for REQUIRED checks the cache TTL is short and a FAILURE is cached only
// as long as its TTL — it never "sticks" success after the dependency goes down.

type Entry<T> = { value: T; at: number };

export function createProbeCache<T>(ttlMs: number, run: () => Promise<T>): () => Promise<T> {
  let cached: Entry<T> | null = null;
  let inflight: Promise<T> | null = null;

  return async function get(): Promise<T> {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) return cached.value;
    if (inflight) return inflight; // single-flight: coalesce concurrent probes
    inflight = (async () => {
      try {
        const value = await run();
        cached = { value, at: Date.now() };
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** Race a promise against a bounded timeout, resolving to `onTimeout` if it elapses. */
export async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((res) => {
    timer = setTimeout(() => res(onTimeout()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
