import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
if (existsSync(".env.demo.local")) process.loadEnvFile(".env.demo.local");
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { alias: { "@": resolve("src") } });
jiti("@/lib/demo/config.ts").demoConfig(); // validates explicit database/host before commands
const run = (args) => {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
switch (process.argv[2]) {
  case "prepare":
    run(["node_modules/prisma/build/index.js", "generate", "--schema", "prisma/production/schema.prisma"]);
    run(["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/production/schema.prisma"]);
    break;
  case "build":
    run(["node_modules/prisma/build/index.js", "generate", "--schema", "prisma/production/schema.prisma"]);
    run(["node_modules/next/dist/bin/next", "build"]);
    break;
  case "dev": run(["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", new URL(process.env.APP_URL).port || "3000"]); break;
  case "start": run(["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", process.env.PORT || new URL(process.env.APP_URL).port || "3000"]); break;
  default: throw new Error("Usage: node scripts/demo-runtime.mjs prepare|build|dev|start");
}
