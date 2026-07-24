"use server";

import { revalidatePath } from "next/cache";
import { getCurrentAccessContext, userHasCompanyRole, recordAudit } from "@/lib/access";
import { checkRateLimit } from "@/lib/rate-limit";
import { setSettingsPin, verifySettingsPin, clearSettingsPinSession } from "@/lib/settings-pin";

export type PinActionState = { ok: boolean; error?: string; notice?: string };

async function ownerContext(): Promise<{ ok: true; companyId: string; userId: string } | { ok: false; error: string }> {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) return { ok: false, error: "Нет доступа." };
  if (!(await userHasCompanyRole(ctx.user.id, ctx.selectedCompanyId, ["owner"]))) {
    return { ok: false, error: "Доступно только собственнику." };
  }
  return { ok: true, companyId: ctx.selectedCompanyId, userId: ctx.user.id };
}

/** Set / change the settings PIN (primary owner only — enforced in the lib). */
export async function setSettingsPinAction(_prev: PinActionState | undefined, formData: FormData): Promise<PinActionState> {
  const g = await ownerContext();
  if (!g.ok) return { ok: false, error: g.error };
  const newPin = String(formData.get("newPin") ?? "").trim();
  const confirmPin = String(formData.get("confirmPin") ?? "").trim();
  const currentPin = String(formData.get("currentPin") ?? "").trim() || undefined;
  if (newPin !== confirmPin) return { ok: false, error: "ПИН и подтверждение не совпадают." };

  const res = await setSettingsPin(g.companyId, g.userId, { currentPin, newPin });
  if (!res.ok) return { ok: false, error: res.error };
  try {
    await recordAudit({ action: "settings.pin_set", entityType: "Company", entityId: g.companyId, companyId: g.companyId, userId: g.userId });
  } catch { /* ignore */ }
  revalidatePath("/settings/security");
  return { ok: true, notice: "ПИН настроек сохранён." };
}

/** Verify the PIN → mint a short-lived verification session. Any owner may verify. */
export async function verifySettingsPinAction(_prev: PinActionState | undefined, formData: FormData): Promise<PinActionState> {
  const g = await ownerContext();
  if (!g.ok) return { ok: false, error: g.error };
  // Throttle attempts (per user + per company) in addition to the lib's failure lock.
  const [u, c] = await Promise.all([
    checkRateLimit("settings_pin", "user", g.userId),
    checkRateLimit("settings_pin", "company", g.companyId),
  ]);
  if (!u.allowed || !c.allowed) return { ok: false, error: "Слишком много попыток. Попробуйте позже." };

  const pin = String(formData.get("pin") ?? "").trim();
  const res = await verifySettingsPin(g.companyId, g.userId, pin);
  try {
    await recordAudit({ action: res.ok ? "settings.pin_verified" : "settings.pin_failed", entityType: "Company", entityId: g.companyId, companyId: g.companyId, userId: g.userId });
  } catch { /* ignore */ }
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/settings");
  revalidatePath("/settings/integrations/ofd");
  return { ok: true, notice: "Доступ к критическим настройкам открыт на 15 минут." };
}

/** Lock critical settings again (revoke the verification session). */
export async function clearSettingsPinAction(): Promise<void> {
  const g = await ownerContext();
  if (!g.ok) return;
  await clearSettingsPinSession(g.companyId, g.userId);
  revalidatePath("/settings/security");
}
