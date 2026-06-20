"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/access";
import {
  getCurrentSessionId,
  revokeCurrentSession,
  revokeSession,
  revokeOtherSessions,
  revokeAllSessionsForUser,
  sessionBelongsToUser,
} from "@/lib/session";

// All actions here operate ONLY on the authenticated user's own sessions.
// Submitted session ids are opaque DB ids; ownership is always revalidated.

/** End a specific own session (by opaque id). If it's the current one, log out. */
export async function endOwnSession(formData: FormData): Promise<void> {
  const user = await requireUser();
  const sessionId = String(formData.get("sessionId") ?? "").trim();
  if (!sessionId) redirect("/settings/security");

  // Revalidate ownership — never trust the submitted id.
  if (!(await sessionBelongsToUser(sessionId, user.id))) {
    redirect("/settings/security");
  }

  const currentId = await getCurrentSessionId();
  if (sessionId === currentId) {
    await revokeCurrentSession("self_current");
    await recordAudit({ action: "session.signed_out", entityType: "Session", entityId: sessionId, userId: user.id, metadata: { self: true } });
    redirect("/login");
  }

  await revokeSession(sessionId, "self_other", user.id);
  await recordAudit({ action: "session.revoked", entityType: "Session", entityId: sessionId, userId: user.id, metadata: { self: true } });
  revalidatePath("/settings/security");
}

/** End all OTHER sessions; the current session stays active. */
export async function endOtherOwnSessions(): Promise<void> {
  const user = await requireUser();
  const currentId = await getCurrentSessionId();
  if (!currentId) redirect("/login");
  const revoked = await revokeOtherSessions(user.id, currentId, "self_other");
  await recordAudit({
    action: "session.revoked_others",
    entityType: "User", entityId: user.id, userId: user.id,
    metadata: { revokedSessions: revoked },
  });
  revalidatePath("/settings/security");
}

/** End ALL sessions including the current one, then log out. */
export async function endAllOwnSessions(): Promise<void> {
  const user = await requireUser();
  const revoked = await revokeAllSessionsForUser(user.id, "self_all", user.id);
  await recordAudit({
    action: "session.revoked_all",
    entityType: "User", entityId: user.id, userId: user.id,
    metadata: { revokedSessions: revoked, self: true },
  });
  // Clear the now-invalid current cookie and log out.
  await revokeCurrentSession("self_all");
  redirect("/login");
}
