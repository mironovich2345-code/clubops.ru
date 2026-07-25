"use server";

// Astral.ОФД stepped-setup server actions (Steps 2-4): load organizations, bind an
// organization to a LegalEntity, load outlets, load KKTs, bind/unbind a KKT to a
// Club + LegalEntity. Reads are owner/GD (no PIN); every MUTATION is PIN-gated and
// tenant-checked (LegalEntity/Club must belong to THIS company; an external id from
// another connection can never be bound). All checks are server-side.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/access";
import {
  requireAstralOwner,
  getAstralConnection,
  buildAstralConfig,
  legalEntityInCompany,
  clubInCompany,
} from "@/lib/ofd/astral/settings";
import { astralClientForConfig, listOrganizations, listOutlets, listKkts, listKktsByAlias, fetchClosedShifts, fetchAnalyticsSummary, probeAstralDocuments, type AstralClosedShiftsSummary, type AstralAnalyticsSummary, type AstralProbeStep } from "@/lib/ofd/astral/api";
import { importAstralSalesForPeriod } from "@/lib/ofd/astral/importer";
import { clubDayRangeUnix } from "@/lib/ofd/astral/receipts";
import type { AstralMaskedOrg } from "@/lib/ofd/providers/astral-provider";
import type { AstralOutlet, AstralKkt } from "@/lib/ofd/astral/normalize";

export type StepOrgsState = { ok: boolean; error?: string; organizations?: AstralMaskedOrg[] };
export type StepOutletsState = { ok: boolean; error?: string; outlets?: AstralOutlet[] };
export type StepKktsState = { ok: boolean; error?: string; kkts?: AstralKkt[] };
export type StepMutState = { ok: boolean; error?: string; notice?: string };

const mut = (error: string): StepMutState => ({ ok: false, error });

// ---- Step 2: organizations ---------------------------------------------------

export async function loadAstralOrganizations(_prev: StepOrgsState | undefined, _formData: FormData): Promise<StepOrgsState> {
  const g = await requireAstralOwner({ pin: false });
  if (!g.ok) return { ok: false, error: g.error };
  const conn = await getAstralConnection(g.companyId);
  if (!conn || !conn.integrationTokenEncrypted) return { ok: false, error: "Сначала сохраните API-ключ." };
  const client = astralClientForConfig(buildAstralConfig(conn));
  if (!client) return { ok: false, error: "Не удалось прочитать API-ключ." };
  const res = await listOrganizations(client, { search: "", page: 1, count: 100 });
  if (!res.ok) return { ok: false, error: res.message };
  return {
    ok: true,
    organizations: res.data.items.map((o) => ({
      externalOrganizationId: o.externalOrganizationId,
      inn: o.inn,
      kpp: o.kpp,
      title: o.shortTitle ?? o.fullTitle,
      statusContract: o.statusContract,
      fnsStatus: o.fnsStatus,
    })),
  };
}

/** Bind the selected Astral organization to a CLUB-OPS LegalEntity (PIN-gated). The
 * user confirms — we never auto-bind by matching ИНН. */
export async function selectAstralOrganization(_prev: StepMutState | undefined, formData: FormData): Promise<StepMutState> {
  const g = await requireAstralOwner({ pin: true });
  if (!g.ok) return mut(g.error);
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  if (!organizationId) return mut("Выберите организацию Астрал.");
  if (!legalEntityId) return mut("Выберите юрлицо CLUB-OPS для привязки.");
  if (!(await legalEntityInCompany(g.companyId, legalEntityId))) return mut("Юрлицо не принадлежит текущей компании.");
  const conn = await getAstralConnection(g.companyId);
  if (!conn) return mut("Подключение Астрал не найдено.");
  await prisma.ofdConnection.update({ where: { id: conn.id }, data: { externalOrganizationId: organizationId, legalEntityId } });
  try {
    await recordAudit({ action: "ofd.astral_organization_selected", entityType: "OfdConnection", entityId: conn.id, companyId: g.companyId, userId: g.userId, metadata: { externalOrganizationId: organizationId, legalEntityId } });
  } catch { /* ignore */ }
  revalidatePath("/settings/ofd/astral");
  revalidatePath("/settings/ofd");
  return { ok: true, notice: "Организация привязана к юрлицу." };
}

// ---- Step 3: outlets (торговые точки) ----------------------------------------

export async function loadAstralOutlets(_prev: StepOutletsState | undefined, _formData: FormData): Promise<StepOutletsState> {
  const g = await requireAstralOwner({ pin: false });
  if (!g.ok) return { ok: false, error: g.error };
  const conn = await getAstralConnection(g.companyId);
  if (!conn?.externalOrganizationId) return { ok: false, error: "Сначала выберите организацию (шаг 2)." };
  const client = astralClientForConfig(buildAstralConfig(conn));
  if (!client) return { ok: false, error: "Не удалось прочитать API-ключ." };
  const res = await listOutlets(client, { organizationId: conn.externalOrganizationId, pageNumber: 1, count: 100 });
  if (!res.ok) return { ok: false, error: res.message };
  return { ok: true, outlets: res.data.items };
}

// ---- Step 4: KKTs ------------------------------------------------------------

export async function loadAstralKkts(_prev: StepKktsState | undefined, formData: FormData): Promise<StepKktsState> {
  const g = await requireAstralOwner({ pin: false });
  if (!g.ok) return { ok: false, error: g.error };
  const conn = await getAstralConnection(g.companyId);
  if (!conn?.externalOrganizationId) return { ok: false, error: "Сначала выберите организацию (шаг 2)." };
  const client = astralClientForConfig(buildAstralConfig(conn));
  if (!client) return { ok: false, error: "Не удалось прочитать API-ключ." };
  const aliasId = String(formData.get("aliasId") ?? "").trim();
  const res = aliasId
    ? await listKktsByAlias(client, { organizationId: conn.externalOrganizationId, aliasId, page: 1, count: 100 })
    : await listKkts(client, { organizationId: conn.externalOrganizationId, page: 1, count: 100 });
  if (!res.ok) return { ok: false, error: res.message };
  return { ok: true, kkts: res.data.items };
}

/** Bind one Astral KKT to a Club + LegalEntity (PIN-gated, tenant-checked). Creates or
 * re-activates an OfdCashRegisterMapping keyed by fnNumber = factoryFiscalDrive. */
export async function bindAstralKkt(_prev: StepMutState | undefined, formData: FormData): Promise<StepMutState> {
  const g = await requireAstralOwner({ pin: true });
  if (!g.ok) return mut(g.error);
  const externalKktId = String(formData.get("externalKktId") ?? "").trim();
  const fnNumber = String(formData.get("fnNumber") ?? "").trim(); // factoryFiscalDrive
  const kktRegId = String(formData.get("kktRegId") ?? "").trim();
  const numberKKT = String(formData.get("numberKKT") ?? "").trim();
  const externalAliasId = String(formData.get("externalAliasId") ?? "").trim();
  const kktName = String(formData.get("kktName") ?? "").trim();
  const clubId = String(formData.get("clubId") ?? "").trim();
  const legalEntityId = String(formData.get("legalEntityId") ?? "").trim();
  if (!fnNumber) return mut("У кассы нет заводского номера ФН — привязка невозможна.");
  if (!clubId) return mut("Выберите клуб для кассы.");
  if (!legalEntityId) return mut("Выберите юрлицо для кассы.");
  if (!(await clubInCompany(g.companyId, clubId))) return mut("Клуб не принадлежит текущей компании.");
  if (!(await legalEntityInCompany(g.companyId, legalEntityId))) return mut("Юрлицо не принадлежит текущей компании.");
  const conn = await getAstralConnection(g.companyId);
  if (!conn?.externalOrganizationId) return mut("Сначала выберите организацию (шаг 2).");

  const activeMappingKey = `astral:${fnNumber}`;
  const existing = await prisma.ofdCashRegisterMapping.findFirst({ where: { companyId: g.companyId, provider: "astral", fnNumber } });
  const data = {
    connectionId: conn.id, companyId: g.companyId, clubId, legalEntityId, provider: "astral",
    fnNumber, kktRegNumber: kktRegId || null, kktFactoryNumber: numberKKT || null, kktName: kktName || null,
    externalOrganizationId: conn.externalOrganizationId, externalAliasId: externalAliasId || null, externalKktId: externalKktId || null,
    isActive: true, activeMappingKey,
  };
  if (existing) {
    await prisma.ofdCashRegisterMapping.update({ where: { id: existing.id }, data });
  } else {
    await prisma.ofdCashRegisterMapping.create({ data });
  }
  try {
    await recordAudit({ action: "ofd.astral_kkt_bound", entityType: "OfdCashRegisterMapping", companyId: g.companyId, userId: g.userId, metadata: { fnNumber, clubId, legalEntityId, externalKktId } });
  } catch { /* ignore */ }
  revalidatePath("/settings/ofd/astral");
  revalidatePath("/settings/ofd");
  return { ok: true, notice: `Касса ${numberKKT || fnNumber} привязана.` };
}

// ---- Step 5: preview + import ------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a 1–3 day range. Preview/import are capped so a test cannot backfill months. */
function validateRange(dateFrom: string, dateTo: string): string | null {
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo) || dateFrom > dateTo) return "Некорректный диапазон дат.";
  const days = Math.round((Date.parse(`${dateTo}T00:00:00+03:00`) - Date.parse(`${dateFrom}T00:00:00+03:00`)) / 86_400_000) + 1;
  if (days < 1 || days > 3) return "Диапазон предпросмотра — не более 3 дней.";
  return null;
}

export type AstralPreviewTrace = {
  endpoint: string;
  organizationId: string;
  externalKktId: string | null;
  numberKKT: string | null;
  kktRegId: string | null;
  fiscalDriveNumber: string;
  kktsSent: number[];
  beginDate: number;
  endDate: number;
  beginIso: string;
  endIso: string;
  operationTypesSent: string[] | null;
};

export type AstralPreview = {
  dateFrom: string;
  dateTo: string;
  fnNumber: string;
  documents: number;
  sales: number;
  returns: number;
  service: number;
  unknown: number;
  incomeKopeks: number;
  returnKopeks: number;
  cashKopeks: number;
  ecashKopeks: number;
  positions: number;
  paymentMismatch: number;
  pages: number;
  foreignSkipped: number;
  closedShifts: AstralClosedShiftsSummary | null;
  closedShiftsError: string | null;
  analytics: AstralAnalyticsSummary | null;
  analyticsError: string | null;
  discrepancyDocVsShiftsKopeks: number;
  discrepancyDocVsAnalyticsKopeks: number;
  trace: AstralPreviewTrace;
  probe: AstralProbeStep[];
};
export type StepPreviewState = { ok: boolean; error?: string; preview?: AstralPreview };
export type StepImportState = { ok: boolean; error?: string; notice?: string; imported?: number; skipped?: number; found?: number };

/** Step 5 preview: fetch + normalize a 1–3 day window for ONE KKT and reconcile the
 * documents total against closed shifts + analytics. Writes NOTHING (dryRun). No PIN
 * (it does not change settings), owner/GD only. */
export async function previewAstralImport(_prev: StepPreviewState | undefined, formData: FormData): Promise<StepPreviewState> {
  const g = await requireAstralOwner({ pin: false });
  if (!g.ok) return { ok: false, error: g.error };
  const fnNumber = String(formData.get("fnNumber") ?? "").trim();
  const dateFrom = String(formData.get("dateFrom") ?? "").trim();
  const dateTo = String(formData.get("dateTo") ?? "").trim();
  if (!fnNumber) return { ok: false, error: "Выберите кассу." };
  const rangeErr = validateRange(dateFrom, dateTo);
  if (rangeErr) return { ok: false, error: rangeErr };

  const conn = await getAstralConnection(g.companyId);
  if (!conn?.externalOrganizationId) return { ok: false, error: "Сначала выберите организацию (шаг 2)." };
  const mapping = await prisma.ofdCashRegisterMapping.findFirst({ where: { companyId: g.companyId, provider: "astral", fnNumber } });
  if (!mapping) return { ok: false, error: "Касса не привязана." };

  // The dryRun import fetches WITHOUT a server-side operationTypes filter and classifies
  // locally — this is the corrected production path.
  const dry = await importAstralSalesForPeriod({ connectionId: conn.id, dateFrom, dateTo, mode: "preview", dryRun: true, onlyKktFnNumbers: [fnNumber] });
  if (!dry.ok) return { ok: false, error: dry.safeMessage ?? dry.safeCode };
  const d = dry.diagnostics;

  const range = clubDayRangeUnix(dateFrom, dateTo);
  const kktsSent = mapping.externalKktId && Number.isFinite(Number(mapping.externalKktId)) ? [Number(mapping.externalKktId)] : [];
  const trace: AstralPreviewTrace = {
    endpoint: "documents.tickets",
    organizationId: conn.externalOrganizationId,
    externalKktId: mapping.externalKktId,
    numberKKT: mapping.kktFactoryNumber,
    kktRegId: mapping.kktRegNumber,
    fiscalDriveNumber: mapping.fnNumber,
    kktsSent,
    beginDate: range.beginDate,
    endDate: range.endDate,
    beginIso: range.beginIso,
    endIso: range.endIso,
    operationTypesSent: null, // preview sends no server-side operationTypes filter
  };

  // A/B/C probe + reconciliation (best-effort; failures never block the preview).
  let probe: AstralProbeStep[] = [];
  let closedShifts: AstralClosedShiftsSummary | null = null;
  let closedShiftsError: string | null = null;
  let analytics: AstralAnalyticsSummary | null = null;
  let analyticsError: string | null = null;
  const client = astralClientForConfig(buildAstralConfig(conn));
  if (client) {
    probe = await probeAstralDocuments(client, { organizationId: conn.externalOrganizationId, beginDate: range.beginDate, endDate: range.endDate, kkts: kktsSent, operationTypes: ["Приход", "Возврат прихода"] });
    const cs = await fetchClosedShifts(client, { organizationId: conn.externalOrganizationId, beginDate: range.beginDate, endDate: range.endDate });
    if (cs.ok) closedShifts = cs.data; else closedShiftsError = cs.message;
    const an = await fetchAnalyticsSummary(client, { organizationId: conn.externalOrganizationId, beginDate: range.beginDate, endDate: range.endDate });
    if (an.ok) analytics = an.data; else analyticsError = an.message;
  }

  const netIncome = d.totalIncomeKopeks - d.totalReturnKopeks;
  return {
    ok: true,
    preview: {
      dateFrom, dateTo, fnNumber,
      documents: d.documentsReceived, sales: d.salesCount, returns: d.returnCount, service: d.serviceCount, unknown: d.unknownDocuments,
      incomeKopeks: d.totalIncomeKopeks, returnKopeks: d.totalReturnKopeks, cashKopeks: d.cashKopeks, ecashKopeks: d.ecashKopeks,
      positions: d.positionsCount, paymentMismatch: d.paymentMismatchCount, pages: d.pagesProcessed, foreignSkipped: d.foreignSkipped,
      closedShifts, closedShiftsError, analytics, analyticsError,
      discrepancyDocVsShiftsKopeks: closedShifts ? netIncome - closedShifts.sumKopeks : 0,
      discrepancyDocVsAnalyticsKopeks: analytics ? netIncome - analytics.profitKopeks : 0,
      trace, probe,
    },
  };
}

/** Step 5 import: really import a 1–3 day window for ONE KKT. Idempotent — re-running
 * creates no duplicates. Owner/GD. Refreshes dashboard/analytics/collections. */
export async function runAstralImport(_prev: StepImportState | undefined, formData: FormData): Promise<StepImportState> {
  const g = await requireAstralOwner({ pin: false });
  if (!g.ok) return { ok: false, error: g.error };
  const fnNumber = String(formData.get("fnNumber") ?? "").trim();
  const dateFrom = String(formData.get("dateFrom") ?? "").trim();
  const dateTo = String(formData.get("dateTo") ?? "").trim();
  if (!fnNumber) return { ok: false, error: "Выберите кассу." };
  const rangeErr = validateRange(dateFrom, dateTo);
  if (rangeErr) return { ok: false, error: rangeErr };
  const conn = await getAstralConnection(g.companyId);
  if (!conn) return { ok: false, error: "Подключение Астрал не найдено." };

  const r = await importAstralSalesForPeriod({ connectionId: conn.id, dateFrom, dateTo, mode: "manual_period", requestedByUserId: g.userId, onlyKktFnNumbers: [fnNumber] });
  if (!r.ok) return { ok: false, error: r.safeMessage ?? r.safeCode };
  try {
    await recordAudit({ action: "ofd.astral_manual_import", entityType: "OfdSyncRun", entityId: r.syncRunId ?? undefined, companyId: g.companyId, userId: g.userId, metadata: { fnNumber, dateFrom, dateTo, found: r.found, imported: r.imported, skipped: r.skipped } });
  } catch { /* ignore */ }
  revalidatePath("/settings/ofd/astral");
  revalidatePath("/dashboard");
  revalidatePath("/analytics/ofd-sales");
  revalidatePath("/collections");
  return { ok: true, notice: `Импортировано: найдено ${r.found}, добавлено ${r.imported}, пропущено ${r.skipped} (статус ${r.status}).`, found: r.found, imported: r.imported, skipped: r.skipped };
}

/** Disable a KKT mapping (PIN-gated). Keeps the row (history) but frees the active key. */
export async function unbindAstralKkt(_prev: StepMutState | undefined, formData: FormData): Promise<StepMutState> {
  const g = await requireAstralOwner({ pin: true });
  if (!g.ok) return mut(g.error);
  const fnNumber = String(formData.get("fnNumber") ?? "").trim();
  if (!fnNumber) return mut("Не указана касса.");
  const existing = await prisma.ofdCashRegisterMapping.findFirst({ where: { companyId: g.companyId, provider: "astral", fnNumber } });
  if (!existing) return mut("Привязка не найдена.");
  await prisma.ofdCashRegisterMapping.update({ where: { id: existing.id }, data: { isActive: false, activeMappingKey: null } });
  try {
    await recordAudit({ action: "ofd.astral_kkt_unbound", entityType: "OfdCashRegisterMapping", entityId: existing.id, companyId: g.companyId, userId: g.userId, metadata: { fnNumber } });
  } catch { /* ignore */ }
  revalidatePath("/settings/ofd/astral");
  revalidatePath("/settings/ofd");
  return { ok: true, notice: "Касса отвязана." };
}
