// Technical deployment identifiers for the health probe. Sourced ONLY from
// Railway's injected system env vars, read at request time from process.env —
// NEVER via git commands and NEVER by reading .git (which is absent in the
// production container anyway). Exposes only non-sensitive deployment
// identifiers (commit SHA, deployment id, environment name); it must never leak
// secrets (OPENAI_API_KEY, DATABASE_URL, SESSION_SECRET, storage creds) or dump
// the full env. Commit SHA + deployment id are technical identifiers and grant
// no financial access.
export type DeploymentVersion = {
  commit: string;
  deploymentId: string | null;
  environment: string;
};

/**
 * Resolve the current deployment's version identifiers. Pure: reads from the
 * passed env (defaults to process.env) so it is trivially testable. Locally,
 * where Railway's vars are absent, commit/environment fall back to "local" and
 * deploymentId to null — the endpoint never throws.
 */
export function deploymentVersion(env: NodeJS.ProcessEnv = process.env): DeploymentVersion {
  return {
    commit: env.RAILWAY_GIT_COMMIT_SHA ?? "local",
    deploymentId: env.RAILWAY_DEPLOYMENT_ID ?? null,
    environment: env.RAILWAY_ENVIRONMENT_NAME ?? "local",
  };
}
