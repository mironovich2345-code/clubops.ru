"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";
import { ofdEnabled, ofdSecretPresent } from "@/lib/ofd/config";
import { encryptOfdSecret, decryptOfdSecret } from "@/lib/ofd/crypto";
import { importTaxcomSalesForPeriod, type ImportMode } from "@/lib/ofd/importer";
import { runSyncNowForCompany } from "@/lib/ofd/daily";
import { createTaxcomClient } from "@/lib/ofd/taxcom/client";
import { normalizeContractNumber, isCurrentAccountValid, type OfdCheckDiagnostics, type OfdSafeContract } from "@/lib/ofd/contract";
import type { OfdConnectionConfig } from "@/lib/ofd/types";

export type OfdSyncSummary = { found: number; imported: number; skipped: number; incomeKopeks: number; returnKopeks: number; succeeded: number; failed: number };
type State = { ok: boolean; error?: string; notice?: string; code?: string; diagnostics?: OfdCheckDiagnostics; matchedContract?: OfdSafeContract; currentSession?: string | null; sync?: OfdSyncSummary };


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

  // Optional: identifies the target ЛК/договор. NOT sent at Login and never
  // blocks saving — it is used only by "Проверить подключение" to confirm, via
  // AccountList, that the expected ЛК is reachable.
  const contractNumber = str(formData, "contractNumber");

  // Secrets require OFD_SECRET to encrypt in production.
  const hasSecrets = ["login", "password", "integrationToken", "integratorId"].some((k) => str(formData, k));
  if (hasSecrets && process.env.NODE_ENV === "production" && !ofdSecretPresent()) {
    return { ok: false, error: "OFD_SECRET не настроен — сохранение секретов недоступно. Обратитесь к администратору системы." };
  }

  const legalEntityId = str(formData, "legalEntityId");
  const existing = await prisma.ofdConnection.findFirst({ where: { companyId: g.companyId, provider: "taxcom" } });

  // A blank field — or the "••••••" placeholder mask if it is ever submitted —
  // means "leave the stored secret unchanged"; only a real new value is encrypted.
  const MASK_RE = /^[•·*∙•]+$/;
  const enc = (k: string): string | undefined => {
    const v = str(formData, k);
    return v && !MASK_RE.test(v) ? encryptOfdSecret(v) : undefined;
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

/** Diagnostics for the saved connection: Login (WITHOUT agreementNumber) → if a
 * sessionToken comes back, call AccountList and confirm the expected договор
 * (contractNumber) is among the reachable ЛК. Never exposes the token/secrets or
 * the raw AccountList — only a safe status and, in the notice, the safe fields of
 * matched ЛК (agreementNumber / название / ИНН). */
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

  const errMap: Record<string, string> = {
    auth_failed: "Ошибка авторизации. Проверьте логин, пароль и Integrator-ID.",
    forbidden: "Доступ запрещён. Проверьте права пользователя в Такском.",
    rate_limited: "Слишком много запросов к Такском. Повторите позже.",
    network: "Сеть недоступна. Повторите позже.",
    timeout: "Сервер Такском не ответил вовремя. Повторите позже.",
    parse_error: "Неожиданный ответ от Такском — токен не получен.",
    not_configured: "Секреты подключения не заполнены.",
  };

  // Step 1 — Login WITHOUT agreementNumber. The token is never returned to the UI.
  const login = await client.login();
  if (!login.ok) {
    await recordAudit({ action: "ofd.connection_checked", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: false, stage: "login", code: login.safeCode } });
    return { ok: false, error: errMap[login.safeCode] ?? "Не удалось подключиться к Такском." };
  }

  // Step 2 — AccountList: the reachable ЛК/договоры for this login.
  const accounts = await client.listAccounts();
  if (!accounts.ok) {
    await recordAudit({ action: "ofd.connection_checked", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: false, stage: "account_list", code: accounts.safeCode } });
    // Login succeeded but we could not enumerate ЛК — still report the good login.
    return { ok: true, notice: "Вход выполнен, но список ЛК получить не удалось. Проверьте права доступа пользователя в Такском." };
  }

  // Build the SINGLE safe availableContracts array ONCE — this is exactly what
  // the UI lists AND what the match runs against, so the two can never diverge.
  const availableContracts = accounts.data.records.map((r) => ({
    agreementNumber: r.agreementNumber,
    companyName: r.companyName ?? null,
    inn: r.inn ?? null,
    kpp: r.kpp ?? null,
  }));

  const requestedContractNumber = c.contractNumber?.trim();
  const requestedNormalized = normalizeContractNumber(requestedContractNumber);
  // Match ONLY by agreementNumber, normalized on both sides (dashes / spaces /
  // case / zero-width / homoglyphs). companyName/inn/kpp never gate success.
  const matchedContract = requestedContractNumber
    ? availableContracts.find((cn) => normalizeContractNumber(cn.agreementNumber) === requestedNormalized)
    : undefined;
  const currentSession = accounts.data.currentAgreementNumber;
  // The договор must be the ACTIVE ЛК (currentSession) — ShiftList/kktstat run on
  // it. Accepts a string currentSession; safe single-record fallback when absent.
  const currentAccountValid = requestedContractNumber
    ? isCurrentAccountValid(currentSession, requestedContractNumber, availableContracts.map((cn) => cn.agreementNumber))
    : null;
  await recordAudit({ action: "ofd.connection_checked", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: true, stage: "account_list", recordsCount: availableContracts.length, contractMatched: requestedContractNumber ? Boolean(matchedContract) : null, currentAccountValid } });

  // Step 3 — verify the expected договор is reachable.
  if (!requestedContractNumber) {
    return { ok: true, notice: "Подключение успешно. Укажите номер договора, если в логине несколько ЛК." };
  }
  if (matchedContract) {
    // The договор is listed, but ShiftList/kktstat operate on the CURRENT ЛК
    // (currentSession). If that differs, the target KKT resolves to 3103 "ККТ не
    // найдена" — so a listed-but-not-current договор is NOT a green success.
    if (currentAccountValid) {
      return { ok: true, notice: "Подключение успешно. Текущий ЛК Такском соответствует выбранному договору.", matchedContract, currentSession };
    }
    return {
      ok: false,
      code: "taxcom_wrong_current_account",
      error: "Подключение выполнено, договор доступен, но текущий ЛК Такском отличается от выбранного договора. Импорт будет невозможен, пока API-сессия не будет открыта в нужном ЛК.",
      matchedContract,
      diagnostics: {
        currentSession,
        requestedContractNumber,
        matchedContract,
        availableContracts,
      },
    };
  }
  // Not found — a WARNING, not a blocking failure. Login itself works. Return
  // SAFE diagnostics (никаких секретов / raw AccountList) so the admin can see
  // which договоры Такском actually returned and pick the right one.
  return {
    ok: false,
    code: "contract_not_found",
    error: "Подключение выполнено, но номер договора не найден среди доступных ЛК Такском.",
    diagnostics: {
      currentSession,
      requestedContractNumber,
      availableContracts,
    },
  };
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

/** On-demand "Синхронизировать сейчас": import TODAY across the company's active
 * Taxcom connections. Owner / general_director only. Idempotent — re-running the
 * same day creates no duplicates. Returns SAFE aggregates only (never secrets /
 * Session-Token / raw response / fiscal JSON / ФПД / PII / stacks). */
export async function syncOfdNowAction(_p: State | undefined, _formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const result = await runSyncNowForCompany(g.companyId);
  await recordAudit({ action: "ofd.sync_now", entityType: "OfdConnection", companyId: g.companyId, userId: g.userId, metadata: { date: result.date, processedConnections: result.processedConnections, succeeded: result.succeeded, failed: result.failed, found: result.totals.foundReceipts, imported: result.totals.importedReceipts, skipped: result.totals.skippedReceipts } });
  revalidatePath("/settings/integrations/ofd");

  if (result.processedConnections === 0) {
    return { ok: true, notice: "Нет активных подключений Такском ОФД для синхронизации." };
  }
  const t = result.totals;
  return {
    ok: true,
    notice: `Синхронизация завершена: найдено ${t.foundReceipts}, добавлено ${t.importedReceipts}, пропущено ${t.skippedReceipts}.`,
    sync: { found: t.foundReceipts, imported: t.importedReceipts, skipped: t.skippedReceipts, incomeKopeks: t.totalIncomeKopeks, returnKopeks: t.totalReturnKopeks, succeeded: result.succeeded, failed: result.failed },
  };
}
