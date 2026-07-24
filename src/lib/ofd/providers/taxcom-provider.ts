// Taxcom provider — wraps the EXISTING, live Taxcom client behind the OfdProvider
// interface. This does NOT replace the importer (importTaxcomSalesForPeriod stays the
// canonical Taxcom import path); it only exposes a uniform testConnection so the
// provider registry is real and Astral can slot in beside it.
import type { OfdConnectionConfig } from "@/lib/ofd/types";
import type { OfdProvider, OfdTestConnectionResult } from "@/lib/ofd/providers/types";
import { createTaxcomClient } from "@/lib/ofd/taxcom/client";

export const TAXCOM_PROVIDER_ID = "taxcom";

export const TaxcomProvider: OfdProvider = {
  id: TAXCOM_PROVIDER_ID,
  label: "Такском ОФД",
  status: "live",
  async testConnection(config: OfdConnectionConfig): Promise<OfdTestConnectionResult> {
    const client = createTaxcomClient(config);
    const accounts = await client.listAccounts();
    if (!accounts.ok) return { ok: false, code: accounts.safeCode, message: accounts.safeMessage ?? "Не удалось авторизоваться." };
    const kkt = await client.listKkt();
    const cashRegisters = kkt.ok ? kkt.data.map((k) => ({ fnNumber: k.fnNumber, name: k.kktName ?? k.outletName ?? null })) : undefined;
    return { ok: true, organization: null, cashRegisters };
  },
};
