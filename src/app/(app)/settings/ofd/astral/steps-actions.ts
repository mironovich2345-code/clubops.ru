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
import { astralClientForConfig, listOrganizations, listOutlets, listKkts, listKktsByAlias } from "@/lib/ofd/astral/api";
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
