// OFD provider registry. Resolves a provider id → its adapter. Taxcom is live; Astral
// is a skeleton (blocked by credentials/documentation). The schema's `provider` column
// drives selection; adding a provider here never touches the Taxcom import path.
import type { OfdProvider } from "@/lib/ofd/providers/types";
import { TaxcomProvider, TAXCOM_PROVIDER_ID } from "@/lib/ofd/providers/taxcom-provider";
import { AstralProvider, ASTRAL_PROVIDER_ID } from "@/lib/ofd/providers/astral-provider";

const PROVIDERS: Record<string, OfdProvider> = {
  [TAXCOM_PROVIDER_ID]: TaxcomProvider,
  [ASTRAL_PROVIDER_ID]: AstralProvider,
};

export function getOfdProvider(id: string): OfdProvider | null {
  return PROVIDERS[id] ?? null;
}

export function listOfdProviders(): OfdProvider[] {
  return Object.values(PROVIDERS);
}
