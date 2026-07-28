// OFD provider registry. Resolves a provider id → its adapter. Taxcom is live; Astral
// is a skeleton (blocked by credentials/documentation). The schema's `provider` column
// drives selection; adding a provider here never touches the Taxcom import path.
import type { OfdProvider } from "@/lib/ofd/providers/types";
import { TaxcomProvider, TAXCOM_PROVIDER_ID } from "@/lib/ofd/providers/taxcom-provider";
import { AstralProvider, ASTRAL_PROVIDER_ID } from "@/lib/ofd/providers/astral-provider";
import { SabyProvider, SABY_PROVIDER_ID } from "@/lib/ofd/providers/saby-provider";
import { ofdSabyEnabled } from "@/lib/ofd/config";

const PROVIDERS: Record<string, OfdProvider> = {
  [TAXCOM_PROVIDER_ID]: TaxcomProvider,
  [ASTRAL_PROVIDER_ID]: AstralProvider,
  // Saby is registered but gated by its feature flag at the UI/action layer.
  [SABY_PROVIDER_ID]: SabyProvider,
};

/** Providers offered in the settings UI — Saby appears only when OFD_SABY_ENABLED is on. */
export function listSelectableOfdProviders(): OfdProvider[] {
  return Object.values(PROVIDERS).filter((p) => p.id !== SABY_PROVIDER_ID || ofdSabyEnabled());
}

export function getOfdProvider(id: string): OfdProvider | null {
  return PROVIDERS[id] ?? null;
}

export function listOfdProviders(): OfdProvider[] {
  return Object.values(PROVIDERS);
}
