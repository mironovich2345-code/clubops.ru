// REM-06 — DATABASE_URL + provider validation (closes OPS-013 for app startup).
//
// PURE: takes an env bag + isProduction and returns a value-free verdict. The full
// DATABASE_URL and its password are NEVER returned or logged — only the provider,
// a SAFE host classification, warnings and a machine error code. Production refuses
// sqlite/file: URLs, empty/malformed URLs, unsupported protocols, and (by default)
// localhost, so the app can never silently run on SQLite or an unintended DB.

export type DbProvider = "postgresql" | "sqlite" | "mysql" | "unknown";
export type HostClass = "localhost" | "private" | "public" | "file" | "unknown";

export type DatabaseValidation = {
  ok: boolean;
  provider: DbProvider;
  expectedProvider: DbProvider;
  hostClass: HostClass;
  errors: string[]; // machine codes, secret-free
  warnings: string[];
};

/** The provider the app EXPECTS for this environment (prod = postgres, else sqlite). */
export function expectedDbProvider(isProduction: boolean): DbProvider {
  return isProduction ? "postgresql" : "sqlite";
}

/** Parse only the protocol → provider. Never dereferences credentials. */
function providerOfUrl(url: string): DbProvider {
  const lower = url.toLowerCase();
  if (lower.startsWith("postgresql://") || lower.startsWith("postgres://")) return "postgresql";
  if (lower.startsWith("file:") || lower.startsWith("sqlite:")) return "sqlite";
  if (lower.startsWith("mysql://")) return "mysql";
  return "unknown";
}

/** Safe host classification WITHOUT exposing the host. Parses defensively. */
function classifyHost(url: string, provider: DbProvider): HostClass {
  if (provider === "sqlite") return "file";
  try {
    // Strip the scheme so the URL parser doesn't choke on postgres://.
    const u = new URL(url.replace(/^postgres(ql)?:\/\//i, "http://"));
    const host = u.hostname.toLowerCase();
    if (!host) return "unknown";
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return "localhost";
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".internal")) return "private";
    return "public";
  } catch {
    return "unknown";
  }
}

/**
 * Validate the database environment. `env.DATABASE_URL` is inspected only for its
 * protocol + host class; the value never leaves this function.
 */
export function validateDatabaseEnvironment(
  env: Record<string, string | undefined>,
  opts: { isProduction: boolean; allowLocalhost?: boolean },
): DatabaseValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const expected = expectedDbProvider(opts.isProduction);
  const raw = (env.DATABASE_URL ?? "").trim();

  if (!raw) {
    return { ok: false, provider: "unknown", expectedProvider: expected, hostClass: "unknown", errors: ["DATABASE_URL_EMPTY"], warnings };
  }

  const provider = providerOfUrl(raw);
  if (provider === "unknown") errors.push("DATABASE_URL_UNSUPPORTED_PROTOCOL");

  // Malformed check: a postgres URL must parse and carry a host.
  const hostClass = classifyHost(raw, provider);
  if (provider === "postgresql" && hostClass === "unknown") errors.push("DATABASE_URL_MALFORMED");

  if (opts.isProduction) {
    if (provider === "sqlite") errors.push("PRODUCTION_SQLITE_FORBIDDEN");
    if (provider !== expected && provider !== "sqlite") errors.push(`PROVIDER_MISMATCH:${provider}!=${expected}`);
    if (hostClass === "localhost" && !opts.allowLocalhost) errors.push("PRODUCTION_LOCALHOST_FORBIDDEN");
    if (hostClass === "localhost" && opts.allowLocalhost) warnings.push("localhost_db_allowed_by_override");
  } else if (provider !== expected) {
    warnings.push(`dev_provider_${provider}`);
  }

  return { ok: errors.length === 0, provider, expectedProvider: expected, hostClass, errors, warnings };
}

/** Reads process.env with the current NODE_ENV + optional localhost override. */
export function resolveDatabaseValidation(): DatabaseValidation {
  return validateDatabaseEnvironment(process.env, {
    isProduction: process.env.NODE_ENV === "production",
    allowLocalhost: process.env.ALLOW_DB_LOCALHOST === "true",
  });
}
