"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";
import { ofdEnabled, ofdSecretPresent } from "@/lib/ofd/config";
import { encryptOfdSecret, decryptOfdSecret } from "@/lib/ofd/crypto";
import { importTaxcomSalesForPeriod, type ImportMode } from "@/lib/ofd/importer";
import { createTaxcomClient } from "@/lib/ofd/taxcom/client";
import type { OfdConnectionConfig } from "@/lib/ofd/types";

type State = { ok: boolean; error?: string; notice?: string };

// Only owner / general director may administer OFD integrations.
async function requireOfdAdmin(): Promise<
  { ok: true; userId: string; companyId: string } | { ok: false; error: string }
> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  const admin = await userHasCompanyRole(ctx.user.id, ctx.selectedCompanyId, ["owner", "general_director"]);
  if (!admin) return { ok: false, error: "Настраивать интеграции может только владелец или ген. директор." };
  if (!ofdEnabled()) return { ok: false, error: "Интеграции ОФД сейчас отключены." };
  return { ok: true, userId: ctx.user.id, companyId: ctx.selectedCompanyId };
}

function str(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v || null;
}

/** Create/update the (single, MVP) Taxcom connection. Secrets are encrypted;
 * empty secret fields on update keep the existing ciphertext. */
export async function saveOfdConnection(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const displayName = str(formData, "displayName");
  const serverBaseUrl = str(formData, "serverBaseUrl");
  const authType = str(formData, "authType") ?? "login_password";
  if (!displayName || !serverBaseUrl) return { ok: false, error: "Укажите название и адрес сервера." };
  if (!/^https:\/\//i.test(serverBaseUrl)) return { ok: false, error: "Адрес сервера должен начинаться с https://" };
  if (!["login_password", "integration_token", "oauth"].includes(authType)) return { ok: false, error: "Неверный тип авторизации." };

  const contractNumber = str(formData, "contractNumber");
  // Taxcom login/password: the agreement (договор) is required to select the
  // right ЛК — without it a multi-organization login resolves to the wrong
  // session and the KKT is reported as "ККТ не найдена".
  if (authType === "login_password" && !contractNumber) {
    return { ok: false, error: "Укажите номер договора Такском, чтобы выбрать нужный личный кабинет." };
  }

  // Secrets require OFD_SECRET to encrypt in production.
  const hasSecrets = ["login", "password", "integrationToken", "integratorId"].some((k) => str(formData, k));
  if (hasSecrets && process.env.NODE_ENV === "production" && !ofdSecretPresent()) {
    return { ok: false, error: "OFD_SECRET не настроен — сохранение секретов недоступно. Обратитесь к администратору системы." };
  }

  const legalEntityId = str(formData, "legalEntityId");
  const existing = await prisma.ofdConnection.findFirst({ where: { companyId: g.companyId, provider: "taxcom" } });

  const enc = (k: string): string | undefined => {
    const v = str(formData, k);
    return v ? encryptOfdSecret(v) : undefined;
  };

  try {
    if (existing) {
      await prisma.ofdConnection.update({
        where: { id: existing.id },
        data: {
          displayName, serverBaseUrl, contractNumber, authType, legalEntityId,
          // Only overwrite a secret when a new value was provided.
          ...(enc("login") !== undefined ? { loginEncrypted: enc("login") } : {}),
          ...(enc("password") !== undefined ? { passwordEncrypted: enc("password") } : {}),
          ...(enc("integrationToken") !== undefined ? { integrationTokenEncrypted: enc("integrationToken") } : {}),
          ...(enc("integratorId") !== undefined ? { integratorIdEncrypted: enc("integratorId") } : {}),
        },
      });
      await recordAudit({ action: "ofd.connection_updated", entityType: "OfdConnection", entityId: existing.id, companyId: g.companyId, userId: g.userId, metadata: { provider: "taxcom", authType } });
    } else {
      const created = await prisma.ofdConnection.create({
        data: {
          companyId: g.companyId, legalEntityId, provider: "taxcom", displayName, serverBaseUrl, contractNumber, authType,
          loginEncrypted: enc("login") ?? null, passwordEncrypted: enc("password") ?? null,
          integrationTokenEncrypted: enc("integrationToken") ?? null, integratorIdEncrypted: enc("integratorId") ?? null,
          createdByUserId: g.userId,
        },
      });
      await recordAudit({ action: "ofd.connection_created", entityType: "OfdConnection", entityId: created.id, companyId: g.companyId, userId: g.userId, metadata: { provider: "taxcom", authType } });
    }
  } catch (error) {
    console.error("saveOfdConnection failed", error instanceof Error ? error.message : error);
    return { ok: false, error: "Не удалось сохранить подключение. Повторите попытку." };
  }
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Подключение сохранено." };
}

/** Check the saved connection: performs ONLY Login (with agreementNumber from
 * contractNumber) and confirms a sessionToken came back. Never exposes the token
 * or secrets; returns a safe status only. */
export async function checkOfdConnection(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const connectionId = str(formData, "connectionId");
  if (!connectionId) return { ok: false, error: "Подключение не найдено." };
  const c = await prisma.ofdConnection.findFirst({ where: { id: connectionId, companyId: g.companyId } });
  if (!c) return { ok: false, error: "Подключение не найдено." };

  const cfg: OfdConnectionConfig = {
    id: c.id, companyId: c.companyId, legalEntityId: c.legalEntityId, provider: c.provider,
    serverBaseUrl: c.serverBaseUrl, authType: c.authType, contractNumber: c.contractNumber,
    login: decryptOfdSecret(c.loginEncrypted), password: decryptOfdSecret(c.passwordEncrypted),
    integrationToken: decryptOfdSecret(c.integrationTokenEncrypted), integratorId: decryptOfdSecret(c.integratorIdEncrypted),
  };
  const client = createTaxcomClient(cfg);
  const res = await client.login(); // Login only — the token is never returned to the client.
  await recordAudit({ action: "ofd.connection_checked", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: res.ok, code: res.ok ? "ok" : res.safeCode } });
  if (res.ok) return { ok: true, notice: "Подключение успешно. Договор выбран." };
  const map: Record<string, string> = {
    auth_failed: "Ошибка авторизации. Проверьте логин, пароль и Integrator-ID.",
    forbidden: "Доступ запрещён. Проверьте права пользователя в Такском.",
    network: "Сеть недоступна. Повторите позже.",
    timeout: "Сервер Такском не ответил вовремя. Повторите позже.",
    parse_error: "Неожиданный ответ от Такском — токен не получен.",
    not_configured: "Секреты подключения не заполнены.",
  };
  return { ok: false, error: map[res.safeCode] ?? "Не удалось подключиться к Такском." };
}

/** Add a KKT (ФН) → club mapping. Blocks a duplicate ACTIVE fn. */
export async function addOfdMapping(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const connectionId = str(formData, "connectionId");
  const fnNumber = str(formData, "fnNumber");
  const clubId = str(formData, "clubId");
  if (!connectionId || !fnNumber || !clubId) return { ok: false, error: "Укажите ФН и клуб." };

  const connection = await prisma.ofdConnection.findFirst({ where: { id: connectionId, companyId: g.companyId } });
  if (!connection) return { ok: false, error: "Подключение не найдено." };
  const club = await prisma.club.findFirst({ where: { id: clubId, companyId: g.companyId }, select: { id: true } });
  if (!club) return { ok: false, error: "Клуб не найден в этой компании." };

  const activeMappingKey = `taxcom:${fnNumber}`;
  try {
    await prisma.ofdCashRegisterMapping.create({
      data: {
        connectionId, companyId: g.companyId, clubId, legalEntityId: str(formData, "legalEntityId") ?? connection.legalEntityId,
        provider: "taxcom", fnNumber, kktRegNumber: str(formData, "kktRegNumber"), kktName: str(formData, "kktName"),
        isActive: true, activeMappingKey,
      },
    });
  } catch (error) {
    // Unique violation on activeMappingKey → an active mapping already exists.
    if (error instanceof Error && /Unique|P2002/.test(error.message)) {
      return { ok: false, error: "Активная касса с этим ФН уже сопоставлена." };
    }
    console.error("addOfdMapping failed", error instanceof Error ? error.message : error);
    return { ok: false, error: "Не удалось добавить кассу. Повторите попытку." };
  }
  await recordAudit({ action: "ofd.mapping_created", entityType: "OfdCashRegisterMapping", companyId: g.companyId, clubId, userId: g.userId, metadata: { provider: "taxcom" } });
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Касса сопоставлена." };
}

/** Enable / disable a mapping. Disabling frees its active fn key. */
export async function toggleOfdMapping(formData: FormData): Promise<void> {
  const g = await requireOfdAdmin();
  if (!g.ok) return;
  const id = String(formData.get("mappingId") ?? "").trim();
  const m = await prisma.ofdCashRegisterMapping.findFirst({ where: { id, companyId: g.companyId } });
  if (!m) return;
  const nextActive = !m.isActive;
  await prisma.ofdCashRegisterMapping.update({
    where: { id },
    data: { isActive: nextActive, activeMappingKey: nextActive ? `taxcom:${m.fnNumber}` : null },
  });
  await recordAudit({ action: nextActive ? "ofd.mapping_enabled" : "ofd.mapping_disabled", entityType: "OfdCashRegisterMapping", entityId: id, companyId: g.companyId, clubId: m.clubId, userId: g.userId, metadata: {} });
  revalidatePath("/settings/integrations/ofd");
}

/** Trigger a manual import for a period (day / period / July backfill). */
export async function runOfdImport(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const connectionId = str(formData, "connectionId");
  const dateFrom = str(formData, "dateFrom");
  const dateTo = str(formData, "dateTo");
  if (!connectionId || !dateFrom || !dateTo) return { ok: false, error: "Укажите период импорта." };
  const connection = await prisma.ofdConnection.findFirst({ where: { id: connectionId, companyId: g.companyId }, select: { id: true } });
  if (!connection) return { ok: false, error: "Подключение не найдено." };

  const mode: ImportMode = dateFrom === "2026-07-01" && dateTo === "2026-07-31" ? "backfill_july" : dateFrom === dateTo ? "manual_day" : "manual_period";
  const res = await importTaxcomSalesForPeriod({ connectionId, dateFrom, dateTo, mode, requestedByUserId: g.userId });
  if (!res.ok) {
    const msg = res.safeCode === "already_running" ? "Импорт уже выполняется. Дождитесь завершения." : res.safeCode === "bad_period" ? "Некорректный период." : "Не удалось выполнить импорт.";
    return { ok: false, error: msg };
  }
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: `Импорт завершён: найдено ${res.found}, добавлено ${res.imported}, пропущено ${res.skipped}.` };
}
