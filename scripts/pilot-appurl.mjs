// APP_URL validation (Part 9.1-9.3). Mirrors the resolution rules in
// src/lib/app-url.ts: valid URL, trailing slash stripped, HTTPS required in
// production, http allowed only outside production, dev default localhost.
// Pure logic — no DB. Run: npm run pilot:appurl

function getAppUrl(appUrl, nodeEnv) {
  const DEV_DEFAULT = "http://localhost:3000";
  const raw = appUrl ? String(appUrl).trim() : "";
  const isProd = nodeEnv === "production";
  const parse = (s) => { try { return new URL(s); } catch { return null; } };
  if (raw) {
    const u = parse(raw);
    if (u && (u.protocol === "https:" || (!isProd && u.protocol === "http:"))) {
      return raw.replace(/\/+$/, "");
    }
  }
  if (isProd) throw new Error("APP_URL is not configured with a valid https:// URL");
  return DEV_DEFAULT;
}

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${extra ? "  :: " + extra : ""}`); c ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

check("1 valid https pilot.clubops.ru in prod", getAppUrl("https://pilot.clubops.ru", "production") === "https://pilot.clubops.ru");
check("trailing slash stripped", getAppUrl("https://pilot.clubops.ru/", "production") === "https://pilot.clubops.ru");
check("2 production rejects http APP_URL", throws(() => getAppUrl("http://pilot.clubops.ru", "production")));
check("2 production rejects garbage APP_URL", throws(() => getAppUrl("not-a-url", "production")));
check("2 production rejects missing APP_URL", throws(() => getAppUrl("", "production")));
check("3 dev defaults to localhost when unset", getAppUrl("", "development") === "http://localhost:3000");
check("3 dev allows http custom", getAppUrl("http://localhost:4000", "development") === "http://localhost:4000");
check("dev allows https too", getAppUrl("https://pilot.clubops.ru", "development") === "https://pilot.clubops.ru");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
