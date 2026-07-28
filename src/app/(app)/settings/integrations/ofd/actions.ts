"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";
import { isRateLimited } from "@/lib/rate-limit";
import { requireSettingsPin } from "@/lib/settings-pin";
import { ofdEnabled, ofdSecretPresent } from "@/lib/ofd/config";
import { encryptOfdSecret, decryptOfdSecret } from "@/lib/ofd/crypto";
import { importTaxcomSalesForPeriod, reclassifyOfdReceiptItemsForCompany, type ImportMode } from "@/lib/ofd/importer";
import { runSyncNowForCompany } from "@/lib/ofd/daily";
import { createTaxcomClient } from "@/lib/ofd/taxcom/client";
import { normalizeContractNumber, isCurrentAccountValid, type OfdCheckDiagnostics, type OfdSafeContract } from "@/lib/ofd/contract";
import type { DocumentInfoShape, NewDocumentsShape, OfdConnectionConfig } from "@/lib/ofd/types";
import { cashRegisterUsage, hasBlockingHistory, recordAssignmentChange, recordFiscalDriveChange } from "@/lib/ofd/cash-register-service";

export type OfdSyncSummary = { found: number; imported: number; skipped: number; incomeKopeks: number; returnKopeks: number; succeeded: number; failed: number };
export type OfdClubResult = { clubName: string; legalName: string | null; found: number; imported: number; incomeKopeks: number; returnKopeks: number };
type State = { ok: boolean; error?: string; notice?: string; code?: string; diagnostics?: OfdCheckDiagnostics; matchedContract?: OfdSafeContract; currentSession?: string | null; sync?: OfdSyncSummary; perClub?: OfdClubResult[]; unboundKkts?: number; clubNote?: string; newDocsShape?: NewDocumentsShape; docInfoShape?: DocumentInfoShape };


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

/**
 * SAFE, non-reversible fingerprint of a Taxcom CABINET identity — sha256 of
 * serverBaseUrl + authType + the account credential (login or token). Used ONLY to
 * detect that two connections point at the SAME cabinet so we never create a duplicate
 * connection just because a different LegalEntity was chosen. The plaintext secret is
 * never logged and never returned — only this hash is compared.
 */
function cabinetFingerprint(serverBaseUrl: string, authType: string, credential: string | null): string | null {
  if (!credential) return null;
  const base = (serverBaseUrl || "").replace(/\/+$/, "").toLowerCase();
  return createHash("sha256").update(`ofd:cabinet:${base}|${authType}|${credential}`).digest("hex");
}

/** Create/update the (single, MVP) Taxcom connection. Secrets are encrypted;
 * empty secret fields on update keep the existing ciphertext. */
export async function saveOfdConnection(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  // Critical settings (ОФД-подключения хранят секреты) требуют подтверждения ПИН —
  // только если ПИН задан для компании (иначе поведение не меняется).
  const pin = await requireSettingsPin(g.companyId, g.userId);
  if (!pin.ok) return { ok: false, error: "Требуется подтверждение ПИН настроек. Откройте «Настройки → Безопасность» и введите ПИН." };

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
  // An explicit connectionId edits that connection. Creating a connection is for a NEW
  // cabinet only — a different LegalEntity is NOT a reason to create a second connection
  // (юрлицо живёт на кассе, не на подключении). Genuinely different cabinets (different
  // credentials) are still allowed.
  const editId = str(formData, "connectionId");
  const existing = editId
    ? await prisma.ofdConnection.findFirst({ where: { id: editId, companyId: g.companyId, provider: "taxcom" } })
    : null;
  if (editId && !existing) return { ok: false, error: "Подключение не найдено." };

  // Cabinet-dedup: block creating a SECOND connection for the same Taxcom cabinet
  // (same server + credentials). This is the fix for the "Такском / Такском · ЮРЛИЦО"
  // duplicate that split KKTs of one cabinet across two connections.
  if (!existing) {
    const newCred = str(formData, "login") ?? str(formData, "integrationToken");
    const newFp = cabinetFingerprint(serverBaseUrl, authType, newCred);
    if (newFp) {
      const siblings = await prisma.ofdConnection.findMany({ where: { companyId: g.companyId, provider: "taxcom" }, select: { id: true, displayName: true, serverBaseUrl: true, authType: true, loginEncrypted: true, integrationTokenEncrypted: true } });
      const dup = siblings.find((s) => cabinetFingerprint(s.serverBaseUrl, s.authType, decryptOfdSecret(s.loginEncrypted) ?? decryptOfdSecret(s.integrationTokenEncrypted)) === newFp);
      if (dup) {
        return { ok: false, error: `Подключение к этому кабинету Такском уже существует («${dup.displayName}»). Не создавайте второе подключение из-за другого юрлица — добавьте кассу к существующему подключению и укажите её юрлицо в кассе.` };
      }
    }
  }

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
      error: `Договор выбран и доступен в AccountList, но Такском открыл API-сессию в другом ЛК: ${currentSession ?? "неизвестен"}. Для импорта нужен текущий ЛК: ${requestedContractNumber}. Уточните у Такском, какой идентификатор/параметр переключает API-сессию на выбранный договор.`,
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

/** Load the SAFE list of договоры from Taxcom AccountList so the admin can pick the
 * right ЛК for a connection. Login → listAccounts, then returns ONLY safe fields:
 * currentSession + records (agreementNumber / companyName / inn / kpp) + the match of
 * the connection's current contractNumber. Never returns the token, secrets, the raw
 * AccountList, or accessRights. On failure returns a safe error message. */
export async function loadTaxcomContractsAction(_p: State | undefined, formData: FormData): Promise<State> {
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
    parse_error: "Неожиданный ответ от Такском.",
    not_configured: "Секреты подключения не заполнены.",
  };

  const login = await client.login();
  if (!login.ok) {
    await recordAudit({ action: "ofd.contracts_loaded", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: false, stage: "login", code: login.safeCode } });
    return { ok: false, error: errMap[login.safeCode] ?? "Не удалось подключиться к Такском." };
  }
  const accounts = await client.listAccounts();
  if (!accounts.ok) {
    await recordAudit({ action: "ofd.contracts_loaded", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: false, stage: "account_list", code: accounts.safeCode } });
    return { ok: false, error: errMap[accounts.safeCode] ?? "Не удалось получить список договоров Такском." };
  }

  // Build the SAFE list ONCE — same fields the UI lists (never accessRights/raw).
  const availableContracts: OfdSafeContract[] = accounts.data.records.map((r) => ({
    agreementNumber: r.agreementNumber, companyName: r.companyName ?? null, inn: r.inn ?? null, kpp: r.kpp ?? null,
  }));
  const currentSession = accounts.data.currentAgreementNumber;
  const requestedContractNumber = c.contractNumber?.trim() ?? "";
  const requestedNormalized = normalizeContractNumber(requestedContractNumber);
  const matchedContract = requestedContractNumber
    ? availableContracts.find((cn) => normalizeContractNumber(cn.agreementNumber) === requestedNormalized) ?? null
    : null;

  await recordAudit({ action: "ofd.contracts_loaded", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: true, recordsCount: availableContracts.length } });
  return {
    ok: true,
    code: "contracts_loaded",
    notice: availableContracts.length ? "Договоры загружены. Выберите нужный ЛК." : "Такском не вернул ни одного договора для этого логина.",
    currentSession,
    diagnostics: { currentSession, requestedContractNumber, availableContracts, matchedContract },
  };
}

/** Save the picked договор as the connection's contractNumber. This alone does NOT
 * make the connection working — that is confirmed only by "Проверить подключение"
 * (currentSession == contractNumber, or the safe single-record fallback). */
export async function selectTaxcomContractAction(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const connectionId = str(formData, "connectionId");
  const agreementNumber = str(formData, "agreementNumber");
  if (!connectionId || !agreementNumber) return { ok: false, error: "Договор не выбран." };
  const c = await prisma.ofdConnection.findFirst({ where: { id: connectionId, companyId: g.companyId }, select: { id: true, displayName: true } });
  if (!c) return { ok: false, error: "Подключение не найдено." };

  await prisma.ofdConnection.update({
    where: { id: c.id },
    // Fill an empty displayName from the договор; otherwise keep the user's name.
    data: { contractNumber: agreementNumber, ...(c.displayName && c.displayName.trim() ? {} : { displayName: `Такском ${agreementNumber}` }) },
  });
  await recordAudit({ action: "ofd.contract_selected", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: {} });
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Договор выбран. Теперь нажмите «Проверить подключение»." };
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

  // Legal entity is chosen PER KKT (one cabinet holds KKTs of different юрлица). It is
  // NOT inherited from the connection. Falls back to the connection's legalEntity only
  // for back-compat if the form omits it; a tenant check guards a cross-company id.
  const legalEntityId = str(formData, "legalEntityId") ?? connection.legalEntityId;
  if (legalEntityId) {
    const le = await prisma.legalEntity.findFirst({ where: { id: legalEntityId, companyId: g.companyId }, select: { id: true } });
    if (!le) return { ok: false, error: "Юрлицо не найдено в этой компании." };
  }

  // Receipt source, NOT a legal entity.
  const registerKind = str(formData, "registerKind") === "online_cashbox" ? "online_cashbox" : "club_cashbox";

  const activeMappingKey = `taxcom:${fnNumber}`;
  try {
    await prisma.ofdCashRegisterMapping.create({
      data: {
        connectionId, companyId: g.companyId, clubId, legalEntityId,
        provider: "taxcom", fnNumber, kktRegNumber: str(formData, "kktRegNumber"), kktName: str(formData, "kktName"),
        registerKind, isActive: true, activeMappingKey,
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
  await recordAudit({ action: "ofd.mapping_created", entityType: "OfdCashRegisterMapping", companyId: g.companyId, clubId, userId: g.userId, metadata: { provider: "taxcom", registerKind } });
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Касса сопоставлена." };
}

/** Change an existing KKT mapping's club and/or legal entity (§7 «Изменить привязку»).
 * Tenant-checked. Used to bind the legal entity for a касса that was created without one
 * (e.g. «Куб» → «требует привязки»). Owner / general_director only, PIN-gated. */
export async function updateOfdMapping(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const pin = await requireSettingsPin(g.companyId, g.userId);
  if (!pin.ok) return { ok: false, error: "Требуется подтверждение ПИН настроек. Откройте «Настройки → Безопасность» и введите ПИН." };

  const mappingId = str(formData, "mappingId");
  if (!mappingId) return { ok: false, error: "Касса не выбрана." };
  const mapping = await prisma.ofdCashRegisterMapping.findFirst({ where: { id: mappingId, companyId: g.companyId, provider: "taxcom" } });
  if (!mapping) return { ok: false, error: "Касса не найдена." };

  const clubId = str(formData, "clubId") ?? mapping.clubId;
  const legalEntityId = str(formData, "legalEntityId"); // required by this form
  const club = await prisma.club.findFirst({ where: { id: clubId, companyId: g.companyId }, select: { id: true } });
  if (!club) return { ok: false, error: "Клуб не найден в этой компании." };
  if (!legalEntityId) return { ok: false, error: "Выберите юрлицо кассы." };
  const le = await prisma.legalEntity.findFirst({ where: { id: legalEntityId, companyId: g.companyId }, select: { id: true } });
  if (!le) return { ok: false, error: "Юрлицо не найдено в этой компании." };

  await prisma.ofdCashRegisterMapping.update({ where: { id: mapping.id }, data: { clubId, legalEntityId } });
  await recordAudit({ action: "ofd.mapping_updated", entityType: "OfdCashRegisterMapping", entityId: mapping.id, companyId: g.companyId, clubId, userId: g.userId, metadata: { provider: "taxcom", fnNumber: mapping.fnNumber } });
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Привязка кассы обновлена." };
}

/**
 * FULL edit of a cash register (§2): FN, РНМ ККТ, name, connection, legal entity, club,
 * register type — from an effective date. Owner/GD + PIN. Changing the binding closes the
 * current assignment and opens a new one; changing the FN keeps the old FN in history. Past
 * receipts are NEVER rewritten (they snapshot their own club/legalEntity/fn at import).
 */
export async function editCashRegister(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const pin = await requireSettingsPin(g.companyId, g.userId);
  if (!pin.ok) return { ok: false, error: "Требуется подтверждение ПИН настроек." };

  const mapping = await prisma.ofdCashRegisterMapping.findFirst({ where: { id: str(formData, "mappingId") ?? "", companyId: g.companyId } });
  if (!mapping) return { ok: false, error: "Касса не найдена." };
  if (mapping.status === "deleted") return { ok: false, error: "Касса удалена — редактирование недоступно." };

  const fnNumber = str(formData, "fnNumber") ?? mapping.fnNumber;
  const kktRegNumber = str(formData, "kktRegNumber");
  const kktName = str(formData, "kktName");
  const connectionId = str(formData, "connectionId") ?? mapping.connectionId;
  const clubId = str(formData, "clubId") ?? mapping.clubId;
  const legalEntityId = str(formData, "legalEntityId");
  const registerKind = str(formData, "registerKind") === "online_cashbox" ? "online_cashbox" : "club_cashbox";
  const effRaw = str(formData, "effectiveFrom");
  const effectiveFrom = effRaw ? new Date(`${effRaw}T00:00:00`) : new Date();
  if (Number.isNaN(effectiveFrom.getTime())) return { ok: false, error: "Некорректная дата привязки." };

  // Tenant validation of every referenced entity.
  const connection = await prisma.ofdConnection.findFirst({ where: { id: connectionId, companyId: g.companyId }, select: { id: true, provider: true } });
  if (!connection) return { ok: false, error: "Подключение не найдено в этой компании." };
  if (connection.provider !== mapping.provider) return { ok: false, error: "Подключение другого провайдера — перенос через отдельное действие." };
  const club = await prisma.club.findFirst({ where: { id: clubId, companyId: g.companyId }, select: { id: true } });
  if (!club) return { ok: false, error: "Клуб не найден в этой компании." };
  if (legalEntityId) {
    const le = await prisma.legalEntity.findFirst({ where: { id: legalEntityId, companyId: g.companyId }, select: { id: true } });
    if (!le) return { ok: false, error: "Юрлицо не найдено в этой компании." };
  }

  // FN conflict: a DIFFERENT active mapping already owns the new FN.
  const fnChanged = fnNumber !== mapping.fnNumber;
  if (fnChanged) {
    const conflict = await prisma.ofdCashRegisterMapping.findFirst({ where: { companyId: g.companyId, provider: mapping.provider, fnNumber, status: { not: "deleted" }, id: { not: mapping.id }, activeMappingKey: { not: null } }, select: { id: true } });
    if (conflict) return { ok: false, error: "Активная касса с этим ФН уже существует. Используйте перенос кассы." };
  }
  const nextActiveKey = mapping.status === "active" ? `${mapping.provider}:${fnNumber}` : mapping.activeMappingKey;

  try {
    await prisma.$transaction(async (tx) => {
      if (fnChanged) await recordFiscalDriveChange(tx, { mapping, fiscalDriveNumber: fnNumber, registrationNumber: kktRegNumber ?? mapping.kktRegNumber, effectiveFrom });
      await recordAssignmentChange(tx, { mapping, clubId, legalEntityId, connectionId, cashRegisterType: registerKind, effectiveFrom, createdById: g.userId, reason: str(formData, "reason") });
      await tx.ofdCashRegisterMapping.update({ where: { id: mapping.id }, data: { fnNumber, kktRegNumber, kktName, connectionId, clubId, legalEntityId, registerKind, activeMappingKey: nextActiveKey } });
    });
  } catch (error) {
    if (error instanceof Error && /Unique|P2002/.test(error.message)) return { ok: false, error: "Конфликт ФН активной кассы." };
    return { ok: false, error: "Не удалось изменить кассу." };
  }
  await recordAudit({ action: "ofd.cash_register_edited", entityType: "OfdCashRegisterMapping", entityId: mapping.id, companyId: g.companyId, clubId, userId: g.userId, metadata: { fnChanged, effectiveFrom: effectiveFrom.toISOString() } });
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Касса изменена." };
}

/**
 * Delete a cash register (§5). Hard delete only when it has NO imported history; otherwise
 * ARCHIVE it (hidden from the active list, sync stopped, current assignment closed) while
 * keeping every receipt / aggregate / attribution. Owner/GD + PIN. The confirm modal tells
 * the user which path applies.
 */
export async function deleteCashRegister(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const pin = await requireSettingsPin(g.companyId, g.userId);
  if (!pin.ok) return { ok: false, error: "Требуется подтверждение ПИН настроек." };
  const mapping = await prisma.ofdCashRegisterMapping.findFirst({ where: { id: str(formData, "mappingId") ?? "", companyId: g.companyId } });
  if (!mapping) return { ok: false, error: "Касса не найдена." };

  const usage = await cashRegisterUsage(mapping);
  const now = new Date();
  if (hasBlockingHistory(usage)) {
    await prisma.$transaction(async (tx) => {
      await tx.ofdCashRegisterAssignment.updateMany({ where: { cashRegisterMappingId: mapping.id, effectiveTo: null }, data: { effectiveTo: now } });
      await tx.ofdCashRegisterMapping.update({ where: { id: mapping.id }, data: { status: "archived", archivedAt: now, isActive: false, activeMappingKey: null } });
    });
    await recordAudit({ action: "ofd.cash_register_archived", entityType: "OfdCashRegisterMapping", entityId: mapping.id, companyId: g.companyId, clubId: mapping.clubId, userId: g.userId, metadata: { receipts: usage.receipts } });
    revalidatePath("/settings/integrations/ofd");
    return { ok: true, notice: "Касса удалена из активных настроек. Исторические чеки и аналитика сохранены." };
  }
  // No history → true hard delete of the mapping + its (empty) history rows.
  await prisma.$transaction(async (tx) => {
    await tx.ofdCashRegisterAssignment.deleteMany({ where: { cashRegisterMappingId: mapping.id } });
    await tx.ofdFiscalDrive.deleteMany({ where: { cashRegisterMappingId: mapping.id } });
    await tx.ofdCashRegisterMapping.delete({ where: { id: mapping.id } });
  });
  await recordAudit({ action: "ofd.cash_register_deleted", entityType: "OfdCashRegisterMapping", entityId: mapping.id, companyId: g.companyId, clubId: mapping.clubId, userId: g.userId, metadata: { hardDelete: true } });
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Пустая касса удалена." };
}

/**
 * HIGH-RISK full purge of a cash register together with ALL imported data (§6). OWNER only,
 * PIN + typed-FN confirmation. Blocked when the data participated in a CLOSED payroll period.
 * Dry-run by default (returns a preview count); `apply=1` executes in a transaction. Audit
 * before and after.
 */
export async function purgeCashRegisterHistory(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const isOwner = await userHasCompanyRole(g.userId, g.companyId, ["owner"]);
  if (!isOwner) return { ok: false, error: "Полное удаление доступно только собственнику." };
  const pin = await requireSettingsPin(g.companyId, g.userId);
  if (!pin.ok) return { ok: false, error: "Требуется подтверждение ПИН настроек." };
  const mapping = await prisma.ofdCashRegisterMapping.findFirst({ where: { id: str(formData, "mappingId") ?? "", companyId: g.companyId } });
  if (!mapping) return { ok: false, error: "Касса не найдена." };

  const usage = await cashRegisterUsage(mapping);
  if (usage.usedInClosedPeriod) return { ok: false, error: "Данные кассы участвуют в закрытом расчётном периоде — полное удаление запрещено." };

  const apply = str(formData, "apply") === "1";
  if (!apply) {
    return { ok: true, notice: `Предпросмотр: будет удалено чеков ${usage.receipts}, позиций ${usage.items}, идентификаторов кассиров ${usage.identities}, атрибуций ${usage.attributions}. Подтвердите вводом ФН и повторным нажатием.` };
  }
  if (str(formData, "confirmFn") !== mapping.fnNumber) return { ok: false, error: "Введите номер ФН для подтверждения." };

  await recordAudit({ action: "ofd.cash_register_purge_started", entityType: "OfdCashRegisterMapping", entityId: mapping.id, companyId: g.companyId, clubId: mapping.clubId, userId: g.userId, metadata: { ...usage, firstReceiptAt: undefined, lastReceiptAt: undefined } });
  const receipts = await prisma.ofdReceiptImport.findMany({ where: { companyId: g.companyId, provider: mapping.provider, fnNumber: mapping.fnNumber }, select: { id: true } });
  const receiptIds = receipts.map((r) => r.id);
  await prisma.$transaction(async (tx) => {
    if (receiptIds.length) await tx.payrollSalesAttribution.deleteMany({ where: { companyId: g.companyId, ofdReceiptId: { in: receiptIds } } });
    await tx.ofdReceiptItem.deleteMany({ where: { companyId: g.companyId, provider: mapping.provider, fnNumber: mapping.fnNumber } });
    await tx.ofdReceiptImport.deleteMany({ where: { companyId: g.companyId, provider: mapping.provider, fnNumber: mapping.fnNumber } });
    const idents = await tx.ofdCashierIdentity.findMany({ where: { companyId: g.companyId, ofdConnectionId: mapping.connectionId, identityKey: { contains: `|${mapping.fnNumber}|` } }, select: { id: true } });
    if (idents.length) { await tx.ofdCashierMapping.deleteMany({ where: { cashierIdentityId: { in: idents.map((i) => i.id) } } }); await tx.ofdCashierIdentity.deleteMany({ where: { id: { in: idents.map((i) => i.id) } } }); }
    await tx.ofdFiscalDrive.deleteMany({ where: { cashRegisterMappingId: mapping.id } });
    await tx.ofdCashRegisterAssignment.deleteMany({ where: { cashRegisterMappingId: mapping.id } });
    await tx.ofdCashRegisterMapping.delete({ where: { id: mapping.id } });
  });
  await recordAudit({ action: "ofd.cash_register_purged", entityType: "OfdCashRegisterMapping", entityId: mapping.id, companyId: g.companyId, clubId: mapping.clubId, userId: g.userId, metadata: { receipts: receiptIds.length } });
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: `Касса и все данные удалены (${receiptIds.length} чеков).` };
}

/** Enable / disable a whole Taxcom connection. A disabled connection is skipped by
 * every import (sync_now / auto_daily / batch). Owner / general_director only. */
export async function toggleOfdConnection(formData: FormData): Promise<void> {
  const g = await requireOfdAdmin();
  if (!g.ok) return;
  const id = String(formData.get("connectionId") ?? "").trim();
  const c = await prisma.ofdConnection.findFirst({ where: { id, companyId: g.companyId }, select: { id: true, isActive: true } });
  if (!c) return;
  await prisma.ofdConnection.update({ where: { id }, data: { isActive: !c.isActive } });
  await recordAudit({ action: c.isActive ? "ofd.connection_disabled" : "ofd.connection_enabled", entityType: "OfdConnection", entityId: id, companyId: g.companyId, userId: g.userId, metadata: {} });
  revalidatePath("/settings/integrations/ofd");
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
    const msg = res.safeCode === "already_running" ? "Импорт уже выполняется. Дождитесь завершения." : res.safeCode === "bad_period" ? "Некорректный период." : res.safeCode === "ofd_no_active_cash_register_mappings" ? "Нет активных касс для этого подключения." : "Не удалось выполнить импорт.";
    return { ok: false, error: msg };
  }

  // Resolve club + legal names for the per-club breakdown (§5.6).
  const clubIds = res.perClub.map((c) => c.clubId);
  const leIds = res.perClub.map((c) => c.legalEntityId).filter((x): x is string => Boolean(x));
  const [clubs, les] = await Promise.all([
    prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } }),
    prisma.legalEntity.findMany({ where: { id: { in: leIds } }, select: { id: true, name: true } }),
  ]);
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const leName = new Map(les.map((l) => [l.id, l.name]));
  const perClub: OfdClubResult[] = res.perClub
    .map((c) => ({ clubName: clubName.get(c.clubId) ?? c.clubId, legalName: c.legalEntityId ? leName.get(c.legalEntityId) ?? null : null, found: c.found, imported: c.imported, incomeKopeks: c.incomeKopeks, returnKopeks: c.returnKopeks }))
    .sort((a, b) => b.imported - a.imported);

  // Header-club note (§8): sync is company/cabinet-wide; the top filter may hide clubs.
  const ctx = await getCurrentAccessContext();
  const currentClubId = ctx?.selectedClubId ?? null;
  const currentClubName = currentClubId ? clubName.get(currentClubId) ?? (await prisma.club.findFirst({ where: { id: currentClubId }, select: { name: true } }))?.name ?? null : null;
  const clubNote = perClub.length > 0
    ? `Синхронизировано клубов: ${perClub.length}.${currentClubName ? ` Сейчас в верхнем фильтре выбран клуб «${currentClubName}» — в разделе «ОФД продажи» показываются данные только по нему.` : ""}`
    : undefined;

  revalidatePath("/settings/integrations/ofd");
  return {
    ok: true,
    notice: `Импорт завершён (${res.status}): найдено ${res.found}, добавлено ${res.imported}, пропущено ${res.skipped}.` + (res.unboundKkts > 0 ? ` Пропущено касс без юрлица: ${res.unboundKkts} (требуют привязки).` : ""),
    perClub, unboundKkts: res.unboundKkts, clubNote,
  };
}

/** On-demand "Синхронизировать сейчас": import TODAY across the company's active
 * Taxcom connections. Owner / general_director only. Idempotent — re-running the
 * same day creates no duplicates. Returns SAFE aggregates only (never secrets /
 * Session-Token / raw response / fiscal JSON / ФПД / PII / stacks). */
export async function syncOfdNowAction(_p: State | undefined, _formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  // Manual-sync cooldown: at most one per company per 5 minutes. The importer's
  // per-connection concurrency guard still applies; the daily CRON is NOT limited
  // (it uses the secret-gated route, not this user action).
  if (await isRateLimited("ofd_sync_now", "company", g.companyId)) {
    return { ok: false, error: "Синхронизация запускалась недавно. Повторите через несколько минут." };
  }

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

/** Re-run nomenclature normalization + categorization over already-imported OFD
 * receipt items using the CURRENT rules, then recompute the category summaries.
 * Owner / general_director only. LOCAL-ONLY — never calls Taxcom, never touches
 * money. Returns SAFE counts only (no names / raw JSON / PII). */
export async function reclassifyOfdCategoriesAction(_p: State | undefined, _formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };

  const res = await reclassifyOfdReceiptItemsForCompany(g.companyId);
  await recordAudit({ action: "ofd.reclassify_categories", entityType: "OfdReceiptItem", companyId: g.companyId, userId: g.userId, metadata: { scanned: res.scanned, updated: res.updated, summaries: res.summariesRecomputed } });
  revalidatePath("/settings/integrations/ofd");

  return { ok: true, notice: `Статьи пересчитаны: обновлено ${res.updated} позиций (из ${res.scanned}).` };
}

/** DIAGNOSTIC ONLY — never touches the money import. Owner / general_director only.
 * Calls GET /API/v2/NewDocuments and returns the SAFE structural shape (key names +
 * counts, whether nomenclature is present). Never stores/returns/logs the raw
 * response, ФПД, secrets or buyer PII. */
export async function inspectOfdNewDocumentsAction(_p: State | undefined, formData: FormData): Promise<State> {
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
  const res = await createTaxcomClient(cfg).inspectNewDocuments();
  await recordAudit({ action: "ofd.newdocuments_inspected", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: res.ok, code: res.ok ? "ok" : res.safeCode, documentCount: res.ok ? res.data.documentCount : null, hasItemsLikeData: res.ok ? res.data.hasItemsLikeData : null } });

  if (!res.ok) {
    const map: Record<string, string> = {
      auth_failed: "Ошибка авторизации. Проверьте логин, пароль и Integrator-ID.",
      no_kkt_found: "Такском: нет доступных ККТ для текущего ЛК (3106).",
      forbidden: "Доступ запрещён. Проверьте права пользователя в Такском.",
      rate_limited: "Слишком много запросов к Такском. Повторите позже.",
      network: "Сеть недоступна. Повторите позже.",
      timeout: "Сервер Такском не ответил вовремя. Повторите позже.",
      parse_error: "Неожиданный ответ от Такском.",
    };
    return { ok: false, error: map[res.safeCode] ?? "Не удалось получить структуру NewDocuments." };
  }
  const s = res.data;
  const notice = s.documentCount === 0
    ? "NewDocuments: за последние 10 суток документов нет (documentCount = 0)."
    : s.hasItemsLikeData
      ? `NewDocuments вернул ${s.documentCount} документ(ов) и содержит позиции чеков — номенклатуру можно будет подключить.`
      : `NewDocuments вернул ${s.documentCount} документ(ов), но позиции чеков в ответе отсутствуют.`;
  return { ok: true, notice, newDocsShape: s };
}

/** DIAGNOSTIC ONLY — never touches the money import. Owner / general_director only.
 * Calls GET /API/v2/DocumentInfo?fn=&fd= for ONE fiscal document and returns the
 * SAFE structural shape (key names + counts, whether nomenclature is present).
 * Never stores/returns/logs the raw response, ФПД, secrets or buyer PII. */
export async function inspectOfdDocumentInfoAction(_p: State | undefined, formData: FormData): Promise<State> {
  const g = await requireOfdAdmin();
  if (!g.ok) return { ok: false, error: g.error };
  const connectionId = str(formData, "connectionId");
  const fnNumber = str(formData, "fnNumber");
  const fdRaw = str(formData, "fdNumber");
  if (!connectionId) return { ok: false, error: "Подключение не найдено." };
  if (!fnNumber || !fdRaw || !/^\d+$/.test(fdRaw)) return { ok: false, error: "Укажите ФН и числовой ФД." };
  const fd = Number(fdRaw);
  const c = await prisma.ofdConnection.findFirst({ where: { id: connectionId, companyId: g.companyId } });
  if (!c) return { ok: false, error: "Подключение не найдено." };

  const cfg: OfdConnectionConfig = {
    id: c.id, companyId: c.companyId, legalEntityId: c.legalEntityId, provider: c.provider,
    serverBaseUrl: c.serverBaseUrl, authType: c.authType, contractNumber: c.contractNumber,
    login: decryptOfdSecret(c.loginEncrypted), password: decryptOfdSecret(c.passwordEncrypted),
    integrationToken: decryptOfdSecret(c.integrationTokenEncrypted), integratorId: decryptOfdSecret(c.integratorIdEncrypted),
  };
  const res = await createTaxcomClient(cfg).inspectDocumentInfo(fnNumber, fd);
  await recordAudit({ action: "ofd.documentinfo_inspected", entityType: "OfdConnection", entityId: c.id, companyId: g.companyId, userId: g.userId, metadata: { ok: res.ok, code: res.ok ? "ok" : res.safeCode, hasItemsLikeData: res.ok ? res.data.hasItemsLikeData : null, itemLikeCount: res.ok ? res.data.itemLikeCount : null } });

  if (!res.ok) {
    const map: Record<string, string> = {
      auth_failed: "Ошибка авторизации. Проверьте логин, пароль и Integrator-ID.",
      kkt_not_found: "Такском: документ/ККТ не найден (3103).",
      no_kkt_found: "Такском: нет доступных ККТ для текущего ЛК (3106).",
      forbidden: "Доступ запрещён. Проверьте права пользователя в Такском.",
      rate_limited: "Слишком много запросов к Такском. Повторите позже.",
      network: "Сеть недоступна. Повторите позже.",
      timeout: "Сервер Такском не ответил вовремя. Повторите позже.",
      parse_error: "Неожиданный ответ от Такском.",
    };
    return { ok: false, error: map[res.safeCode] ?? "Не удалось получить структуру DocumentInfo." };
  }
  const d = res.data;
  const notice = d.hasItemsLikeData
    ? `DocumentInfo содержит позиции чека (найдено ${d.itemLikeCount}${d.numericFfdModeDetected ? ", формат ФФД тег 1059" : ""}) — номенклатуру можно будет подключить.`
    : d.numericFfdModeDetected
      ? "DocumentInfo: тег 1059 (предмет расчёта) найден, но его формат не распознан как позиции."
      : "DocumentInfo: позиции чека в ответе отсутствуют.";
  return { ok: true, notice, docInfoShape: d };
}
