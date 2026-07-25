// Astral.ОФД provider. Status: READY FOR CREDENTIALS.
//
// The integration code is now REAL — a working v4.2 API client (src/lib/ofd/astral/*),
// catalog methods and receipt normalization built strictly from the official
// «Документация Астрал ОФД API.pdf». It is NOT marked "live" because no request with a
// real, active api_key has been executed + reconciled in THIS deployment (project rule
// #7). testConnection performs a real organization.list call: with a valid key it
// succeeds; without a key it refuses honestly. See docs/integrations/astral-ofd-*.md.
import type { OfdConnectionConfig } from "@/lib/ofd/types";
import type { OfdProvider, OfdTestConnectionResult } from "@/lib/ofd/providers/types";
import type { AstralClientOpts } from "@/lib/ofd/astral/client";
import { astralClientForConfig, listOrganizations } from "@/lib/ofd/astral/api";
import type { AstralOrganization } from "@/lib/ofd/astral/normalize";

export const ASTRAL_PROVIDER_ID = "astral";

/** A SAFE, masked organization descriptor for the settings UI (no secrets). */
export type AstralMaskedOrg = {
  externalOrganizationId: string;
  inn: string | null;
  kpp: string | null;
  title: string | null;
  statusContract: string | null;
  fnsStatus: string | null;
};

function maskOrg(o: AstralOrganization): AstralMaskedOrg {
  return {
    externalOrganizationId: o.externalOrganizationId,
    inn: o.inn,
    kpp: o.kpp,
    title: o.shortTitle ?? o.fullTitle,
    statusContract: o.statusContract,
    fnsStatus: o.fnsStatus,
  };
}

export type AstralTestDetailed =
  | { ok: true; organizationCount: number; organizations: AstralMaskedOrg[] }
  | { ok: false; code: string; message: string };

/**
 * Real connection check per the PDF: POST /organization.list with search="",
 * page="1", count=10. Success only if ok=true AND result.organizations is an array.
 * Imports NOTHING. Returns a masked org list for the UI.
 */
export async function testAstralConnectionDetailed(config: OfdConnectionConfig, opts?: AstralClientOpts): Promise<AstralTestDetailed> {
  const client = astralClientForConfig(config, opts);
  if (!client) {
    return { ok: false, code: "ASTRAL_NOT_CONFIGURED", message: "Astral: сначала сохраните API-ключ." };
  }
  const res = await listOrganizations(client, { search: "", page: 1, count: 10 });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true, organizationCount: res.data.totalCount || res.data.items.length, organizations: res.data.items.map(maskOrg) };
}

export const AstralProvider: OfdProvider = {
  id: ASTRAL_PROVIDER_ID,
  label: "Астрал.ОФД",
  // Not "live": the code is complete but no real-credential request has been
  // reconciled in this deployment yet. Becomes effectively connected per-company
  // once real sync runs import receipts (see providers/status.ts).
  status: "ready_for_credentials",
  async testConnection(config: OfdConnectionConfig): Promise<OfdTestConnectionResult> {
    const r = await testAstralConnectionDetailed(config);
    if (!r.ok) return { ok: false, code: r.code, message: r.message };
    const org = r.organizations[0];
    return { ok: true, organization: org ? org.title ?? org.inn ?? String(r.organizationCount) : `${r.organizationCount}` };
  },
};
