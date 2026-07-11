// Technical deployment identifiers for the health probe. Sourced ONLY from
// injected system env vars, read at request time from process.env — NEVER via
// git commands and NEVER by reading .git (which is absent in the production
// container anyway). Exposes only non-sensitive deployment identifiers (commit
// SHA, deployment id, environment name); it must never leak secrets
// (OPENAI_API_KEY, DATABASE_URL, SESSION_SECRET, storage creds, or any cloud
// project/folder/service-account id) or dump the full env. Commit SHA +
// deployment id are technical identifiers and grant no financial access.
//
// Resolution priority (first non-empty wins), so the same code runs on both the
// current Railway host and the new Yandex Cloud / self-hosted Docker host:
//   1. Yandex / self-hosted image metadata: APP_GIT_SHA / APP_DEPLOYMENT_ID /
//      APP_ENVIRONMENT (APP_GIT_SHA is baked into the image at build time).
//   2. Railway injected vars: RAILWAY_GIT_COMMIT_SHA / RAILWAY_DEPLOYMENT_ID /
//      RAILWAY_ENVIRONMENT_NAME.
//   3. local fallback ("local" / null).
export type DeploymentVersion = {
  commit: string;
  deploymentId: string | null;
  environment: string;
};

// Treat "" the same as unset so an empty ARG/ENV never wins over the next tier.
function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const v of values) if (typeof v === "string" && v.trim() !== "") return v;
  return null;
}

/**
 * Resolve the current deployment's version identifiers. Pure: reads from the
 * passed env (defaults to process.env) so it is trivially testable. With no
 * deployment vars set, commit/environment fall back to "local" and deploymentId
 * to null — the endpoint never throws.
 */
export function deploymentVersion(env: NodeJS.ProcessEnv = process.env): DeploymentVersion {
  return {
    commit: firstNonEmpty(env.APP_GIT_SHA, env.RAILWAY_GIT_COMMIT_SHA) ?? "local",
    deploymentId: firstNonEmpty(env.APP_DEPLOYMENT_ID, env.RAILWAY_DEPLOYMENT_ID),
    environment: firstNonEmpty(env.APP_ENVIRONMENT, env.RAILWAY_ENVIRONMENT_NAME) ?? "local",
  };
}
