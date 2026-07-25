// Server-only helpers for the Astral.ОФД stepped settings screen. NOT a "use server"
// module — it exports utilities (config builder, owner+PIN guard, tenant checks) used
// by the step server actions. Secrets are decrypted here only in memory for one call.
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole } from "@/lib/access";
import { ofdEnabled } from "@/lib/ofd/config";
import { decryptOfdSecret } from "@/lib/ofd/crypto";
import { requireSettingsPin } from "@/lib/settings-pin";
import type { OfdConnectionConfig } from "@/lib/ofd/types";

export const ASTRAL_PIN_MSG = "Требуется подтверждение ПИН настроек. Откройте «Настройки → Безопасность» и введите ПИН.";

type AstralConnRow = {
  id: string;
  companyId: string;
  legalEntityId: string | null;
  provider: string;
  serverBaseUrl: string;
  authType: string;
  contractNumber: string | null;
  integrationTokenEncrypted: string | null;
};

/** Build an in-memory decrypted connection config (api_key = integration token). */
export function buildAstralConfig(conn: AstralConnRow): OfdConnectionConfig {
  return {
    id: conn.id,
    companyId: conn.companyId,
    legalEntityId: conn.legalEntityId,
    provider: conn.provider,
    serverBaseUrl: conn.serverBaseUrl,
    authType: conn.authType,
    contractNumber: conn.contractNumber,
    login: null,
    password: null,
    integrationToken: decryptOfdSecret(conn.integrationTokenEncrypted),
    integratorId: null,
  };
}

export type AstralGuardOk = { ok: true; companyId: string; userId: string };
export type AstralGuardErr = { ok: false; error: string };

/**
 * Owner / general_director only, integrations enabled, and (for mutations) a verified
 * settings-PIN session. ALL server-side — direct-form callers cannot bypass it.
 */
export async function requireAstralOwner(opts: { pin: boolean }): Promise<AstralGuardOk | AstralGuardErr> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!(await userHasCompanyRole(ctx.user.id, ctx.selectedCompanyId, ["owner", "general_director"]))) {
    return { ok: false, error: "Настраивать интеграции может только владелец или ген. директор." };
  }
  if (!ofdEnabled()) return { ok: false, error: "Интеграции ОФД сейчас отключены." };
  if (opts.pin) {
    const p = await requireSettingsPin(ctx.selectedCompanyId, ctx.user.id);
    if (!p.ok) return { ok: false, error: ASTRAL_PIN_MSG };
  }
  return { ok: true, companyId: ctx.selectedCompanyId, userId: ctx.user.id };
}

/** The single active Astral connection for a company (there is at most one). */
export async function getAstralConnection(companyId: string) {
  return prisma.ofdConnection.findFirst({ where: { companyId, provider: "astral" } });
}

/** Tenant guard: the legal entity must belong to THIS company. */
export async function legalEntityInCompany(companyId: string, legalEntityId: string): Promise<boolean> {
  if (!legalEntityId) return false;
  const le = await prisma.legalEntity.findFirst({ where: { id: legalEntityId, companyId }, select: { id: true } });
  return Boolean(le);
}

/** Tenant guard: the club must belong to THIS company. */
export async function clubInCompany(companyId: string, clubId: string): Promise<boolean> {
  if (!clubId) return false;
  const club = await prisma.club.findFirst({ where: { id: clubId, companyId }, select: { id: true } });
  return Boolean(club);
}
