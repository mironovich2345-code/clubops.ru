"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getValidSession } from "@/lib/session";
import { signOut } from "@/lib/auth";
import { recordAudit } from "@/lib/access";
import {
  setAddAccountIntent,
  ensureCurrentAccountStored,
  switchAccount,
  removeAccount,
  logoutAllAccounts,
} from "@/lib/account-container";

// Multi-account server actions (spec §5/§6/§8). All ownership/validity checks live
// in the account-container service; these thin actions add audit + navigation +
// the layout revalidation that a change of active identity requires.

/** «Добавить аккаунт»: snapshot the current account into the device container (so it
 *  is preserved + stays active), flag add-account intent, then show the login form. */
export async function startAddAccountAction(): Promise<void> {
  const v = await getValidSession();
  if (v) {
    await ensureCurrentAccountStored(v.session.id, v.user.id);
    await setAddAccountIntent();
    await recordAudit({ action: "account.add_started", entityType: "User", entityId: v.user.id, userId: v.user.id });
  }
  redirect("/login?mode=add-account");
}

/** Switch the active account. A revoked/expired target routes to re-login (§7). */
export async function switchAccountAction(formData: FormData): Promise<void> {
  const storedId = String(formData.get("storedId") ?? "").trim();
  const res = await switchAccount(storedId);
  if (!res.ok) {
    if (res.error === "expired") redirect("/login?mode=add-account"); // that account needs re-login
    redirect("/"); // not_found / no_container — nothing to do
  }
  const v = await getValidSession();
  if (v) await recordAudit({ action: "account.switched", entityType: "User", entityId: v.user.id, userId: v.user.id });
  revalidatePath("/", "layout");
  redirect("/");
}

/** Remove one account from THIS device (revokes its session, keeps the others). */
export async function removeAccountAction(formData: FormData): Promise<void> {
  const storedId = String(formData.get("storedId") ?? "").trim();
  const res = await removeAccount(storedId);
  await recordAudit({ action: "account.removed_from_device", entityType: "StoredAccountSession", entityId: storedId });
  if (res.empty) redirect("/login");
  revalidatePath("/", "layout");
  redirect("/");
}

/** Sign out of EVERY account on this device (and the legacy single-session cookie,
 *  so it also works when no container exists yet). */
export async function logoutAllAction(): Promise<void> {
  await recordAudit({ action: "account.logout_all", entityType: "AccountSessionContainer" });
  await logoutAllAccounts();       // revoke all container sessions + clear container/scope cookies
  await signOut();                 // revoke + clear the legacy club_ops_session cookie too
  redirect("/login");
}
