// Detects "stale chunk after deploy" errors. When a new build is deployed, a
// still-open tab references old chunk hashes that no longer exist; the dynamic
// import 404s and React throws. Next renders this as the generic
// "Application error: a client-side exception has occurred". Recovering is a
// single page reload to fetch the fresh HTML + chunks.

const CHUNK_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk [\w-]+ failed/i,
  /Loading CSS chunk/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? "";
  const message = (error as { message?: string }).message ?? "";
  if (name === "ChunkLoadError") return true;
  return CHUNK_PATTERNS.some((re) => re.test(name) || re.test(message));
}

const RELOAD_KEY = "clubops_chunk_reload_at";
// Don't reload again if we just did (avoids an infinite loop when the failure
// is not actually a stale chunk); re-arms after the window so a future deploy
// can self-heal again.
const RELOAD_WINDOW_MS = 10_000;

/**
 * If the error is a stale-chunk error, reload once and report that recovery is
 * underway. Returns true when a reload was triggered (caller should render a
 * minimal "updating" state rather than an error UI).
 */
export function recoverFromChunkError(error: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(error)) return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? "0");
    if (Date.now() - last < RELOAD_WINDOW_MS) return false; // already tried just now
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable (private mode etc.) — reload anyway.
  }
  window.location.reload();
  return true;
}
