// Saby ОФД / СБИС ОФД provider (pilot). Status: BLOCKED_BY_CREDENTIALS — endpoints are built
// from the official API docs (api.sbis.ru), but the auth request/response and receipt JSON
// keys are not yet reconciled on a real cabinet, so testConnection refuses honestly rather
// than fabricating a call. Gated behind the OFD_SABY_ENABLED feature flag + owner/system admin.
import type { OfdConnectionConfig } from "@/lib/ofd/types";
import type { OfdProvider, OfdTestConnectionResult } from "@/lib/ofd/providers/types";
import { SabyOfdClient } from "@/lib/ofd/saby/client";

export const SABY_PROVIDER_ID = "saby";

export const SabyProvider: OfdProvider = {
  id: SABY_PROVIDER_ID,
  label: "Saby ОФД (СБИС)",
  status: "blocked_by_credentials",
  async testConnection(config: OfdConnectionConfig): Promise<OfdTestConnectionResult> {
    const client = new SabyOfdClient();
    const auth = await client.authenticate(config);
    if (!auth.ok) return { ok: false, code: auth.code, message: auth.message };
    // With a verified session the KKT list would be read here (no import).
    return { ok: false, code: "SABY_TEST_UNVERIFIED", message: "Saby: подключение не проверено на реальном кабинете." };
  },
};
