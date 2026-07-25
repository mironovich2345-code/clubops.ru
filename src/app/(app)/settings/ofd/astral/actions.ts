"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";
import { ofdEnabled } from "@/lib/ofd/config";
import { encryptOfdSecret, decryptOfdSecret } from "@/lib/ofd/crypto";
import { requireSettingsPin } from "@/lib/settings-pin";
import { getOfdProvider } from "@/lib/ofd/providers/registry";
import type { OfdConnectionConfig } from "@/lib/ofd/types";

export type AstralState = { ok: boolean; error?: string; notice?: string };
const fail = (error: string): AstralState => ({ ok: false, error });
const PIN_MSG = "Требуется подтверждение ПИН настроек. Откройте «Настройки → Безопасность» и введите ПИН.";

/** Owner / general director only; critical Astral changes also require a verified PIN. */
async function requireAstralAdmin(pin: boolean): Promise<{ ok: true; companyId: string; userId: string } | { ok: false; error: string }> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!(await userHasCompanyRole(ctx.user.id, ctx.selectedCompanyId, ["owner", "general_director"]))) {
    return { ok: false, error: "Настраивать интеграции может только владелец или ген. директор." };
  }
  if (!ofdEnabled()) return { ok: false, error: "Интеграции ОФД сейчас отключены." };
  if (pin) {
    const p = await requireSettingsPin(ctx.selectedCompanyId, ctx.user.id);
    if (!p.ok) return { ok: false, error: PIN_MSG };
  }
  return { ok: true, companyId: ctx.selectedCompanyId, userId: ctx.user.id };
}

/** Save / update the Astral API key. Empty field = keep the previous key. PIN-gated. */
export async function saveAstralApiKey(_prev: AstralState | undefined, formData: FormData): Promise<AstralState> {
  const g = await requireAstralAdmin(true);
  if (!g.ok) return fail(g.error);
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const existing = await prisma.ofdConnection.findFirst({ where: { companyId: g.companyId, provider: "astral" } });
  if (!existing && !apiKey) return fail("Введите API-ключ Астрал.ОФД.");

  if (existing) {
    await prisma.ofdConnection.update({
      where: { id: existing.id },
      data: apiKey ? { integrationTokenEncrypted: encryptOfdSecret(apiKey) } : {},
    });
  } else {
    await prisma.ofdConnection.create({
      data: {
        companyId: g.companyId,
        provider: "astral",
        displayName: "Астрал.ОФД",
        serverBaseUrl: "", // подтверждённый базовый URL задаётся после получения документации
        authType: "integration_token",
        integrationTokenEncrypted: encryptOfdSecret(apiKey),
        isActive: true,
        createdByUserId: g.userId,
      },
    });
  }
  try {
    await recordAudit({ action: "ofd.astral_api_key_saved", entityType: "OfdConnection", companyId: g.companyId, userId: g.userId, metadata: { provider: "astral" } });
  } catch { /* ignore */ }
  revalidatePath("/settings/ofd/astral");
  revalidatePath("/settings/ofd");
  return { ok: true, notice: "API-ключ сохранён." };
}

/**
 * Test the Astral connection. Honest by design: without real credentials + confirmed
 * endpoints the Astral provider refuses (BLOCKED BY CREDENTIALS/DOCUMENTATION) rather
 * than pretending. No data is imported by a test.
 */
export async function testAstralConnection(_prev: AstralState | undefined, _formData: FormData): Promise<AstralState> {
  const g = await requireAstralAdmin(false);
  if (!g.ok) return fail(g.error);
  const conn = await prisma.ofdConnection.findFirst({ where: { companyId: g.companyId, provider: "astral" } });
  if (!conn || !conn.integrationTokenEncrypted) return fail("Сначала сохраните API-ключ.");
  const provider = getOfdProvider("astral");
  if (!provider) return fail("Провайдер Астрал недоступен.");
  const config: OfdConnectionConfig = {
    id: conn.id,
    companyId: conn.companyId,
    legalEntityId: conn.legalEntityId,
    provider: "astral",
    serverBaseUrl: conn.serverBaseUrl,
    authType: conn.authType,
    contractNumber: conn.contractNumber,
    login: null,
    password: null,
    integrationToken: (() => { try { return decryptOfdSecret(conn.integrationTokenEncrypted!); } catch { return null; } })(),
    integratorId: null,
  };
  const res = await provider.testConnection(config);
  return res.ok ? { ok: true, notice: "Подключение подтверждено." } : fail(res.message);
}

/** Enable / disable the Astral connection. PIN-gated. */
export async function toggleAstralConnection(formData: FormData): Promise<void> {
  const g = await requireAstralAdmin(true);
  if (!g.ok) return;
  const conn = await prisma.ofdConnection.findFirst({ where: { companyId: g.companyId, provider: "astral" } });
  if (!conn) return;
  await prisma.ofdConnection.update({ where: { id: conn.id }, data: { isActive: !conn.isActive } });
  try {
    await recordAudit({ action: "ofd.astral_toggled", entityType: "OfdConnection", entityId: conn.id, companyId: g.companyId, userId: g.userId, metadata: { isActive: !conn.isActive } });
  } catch { /* ignore */ }
  revalidatePath("/settings/ofd/astral");
  revalidatePath("/settings/ofd");
}
