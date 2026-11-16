// Pure configuration gate, also usable in Edge middleware and setup scripts.
// Any demo flag with incomplete configuration fails closed before database I/O.
export type DemoEnv = Record<string, string | undefined>;
export const DEMO_ROLES = ["owner", "general_director", "regional_director", "manager", "accountant"] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];
export const DEMO_MONTH = "2026-11";
export const DEMO_AS_OF = "2026-11-15";
export const DEMO_TTL_MS = 2 * 60 * 60 * 1000;

export function demoRequested(env: DemoEnv = process.env): boolean {
  return env.DEMO_MODE !== undefined && env.DEMO_MODE !== "false" && env.DEMO_MODE !== "";
}

export function demoConfig(env: DemoEnv = process.env) {
  if (env.DEMO_MODE !== "true" || env.APP_ENVIRONMENT !== "standalone-demo") throw new Error("DEMO_DISABLED");
  const app = new URL(env.APP_URL ?? "");
  const local = ["localhost", "127.0.0.1"].includes(app.hostname);
  if (app.username || app.password || app.pathname !== "/" || app.search || app.hash ||
      app.host !== env.DEMO_ALLOWED_HOST ||
      (!local && (!app.hostname.endsWith(".up.railway.app") || app.protocol !== "https:")) ||
      (local && app.protocol !== "http:")) throw new Error("DEMO_HOST_FORBIDDEN");
  const db = new URL(env.DATABASE_URL ?? "");
  const name = db.pathname.slice(1);
  if (!["postgres:", "postgresql:"].includes(db.protocol) ||
      !/^clubops_demo_[a-z0-9_]+$/.test(name) || name !== env.DEMO_DATABASE_NAME ||
      db.host !== env.DEMO_DATABASE_HOST || (db.searchParams.get("schema") ?? "public") !== "public") {
    throw new Error("DEMO_DATABASE_FORBIDDEN");
  }
  // Do not merely hide buttons: refuse a deployment with live services configured.
  if ((env.AI_PROVIDER && env.AI_PROVIDER !== "mock") || env.OFD_INTEGRATIONS_ENABLED === "true" ||
      env.TELEGRAM_NOTIFICATIONS_ENABLED === "true" || env.STORAGE_PROVIDER === "s3" ||
      ["SMTP_USER", "SMTP_PASSWORD", "EMAIL_SERVER_PASSWORD", "TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY",
       "YANDEX_AI_API_KEY", "RU_AI_API_KEY", "OFD_SECRET", "S3_ACCESS_KEY_ID", "STORAGE_S3_ACCESS_KEY_ID"]
        .some((key) => Boolean(env[key]))) throw new Error("DEMO_EXTERNAL_SERVICE_FORBIDDEN");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || env.SESSION_SECRET.startsWith("change-me")) {
    throw new Error("DEMO_SESSION_SECRET_REQUIRED");
  }
  return { origin: app.origin, host: app.host, local, databaseName: name };
}

export function isDemo(env: DemoEnv = process.env): boolean {
  if (!demoRequested(env)) return false;
  demoConfig(env);
  return true;
}

export function assertDemoRequest(host: string | null, origin?: string | null) {
  const config = demoConfig();
  if (host !== config.host || (origin != null && origin !== config.origin)) throw new Error("DEMO_ORIGIN_FORBIDDEN");
  return config;
}

export function assertNoDemoExternalAction(): void {
  if (demoRequested()) throw new Error("Демо: внешние действия и изменение учётных данных отключены");
}
