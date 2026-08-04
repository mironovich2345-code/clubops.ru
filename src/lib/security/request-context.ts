// REM-07 — request correlation context (spec §3/§5). The requestId is minted by the
// middleware (server-side, crypto UUID) and read here from the `x-request-id` request
// header — an inbound client header is never trusted (the middleware overwrites it).
// A session token / entity id is NEVER used as the id.
import { headers } from "next/headers";
import { deploymentVersion } from "@/lib/deployment-version";
import type { SecuritySource } from "./event-types";

export type SecurityRequestContext = {
  requestId: string | null;
  timestamp: string;
  actorId: string | null;
  companyId: string | null;
  role: string | null;
  route: string | null;
  source: SecuritySource;
  deploymentVersion: string | null;
};

/** The server-generated correlation id for the current request (or null off-request). */
export async function getRequestId(): Promise<string | null> {
  try {
    const h = await headers();
    const id = h.get("x-request-id");
    return id && id.length <= 64 ? id : null;
  } catch {
    return null; // not in a request scope (e.g. a background job)
  }
}

/** Assemble a safe request context. All fields are safe-to-log; no tokens/PII. */
export async function buildSecurityContext(opts?: {
  actorId?: string | null;
  companyId?: string | null;
  role?: string | null;
  route?: string | null;
  source?: SecuritySource;
}): Promise<SecurityRequestContext> {
  return {
    requestId: await getRequestId(),
    timestamp: new Date().toISOString(),
    actorId: opts?.actorId ?? null,
    companyId: opts?.companyId ?? null,
    role: opts?.role ?? null,
    route: opts?.route ?? null,
    source: opts?.source ?? "web",
    deploymentVersion: deploymentVersion().commit,
  };
}
