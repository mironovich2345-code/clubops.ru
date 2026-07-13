"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { hashInviteToken } from "@/lib/invites";
import { applyInvite } from "@/lib/invite-service";

// Manual accept route (kept for legacy links and compatibility). New users get
// their invites auto-applied at email verification, but an explicit accept via a
// token link or the by-id list still works and uses the same transactional,
// strictly single-use helper.
export async function acceptInvite(formData: FormData): Promise<void> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "");
  const inviteId = String(formData.get("inviteId") ?? "");
  // Token links return to themselves on failure; the no-token (by-id) flow
  // returns to the email-based list.
  const back = token ? `/accept-invite?token=${encodeURIComponent(token)}` : "/accept-invite";

  // Resolve the invite by token (unauthenticated link) or by id (logged-in user
  // accepting an invite addressed to their email).
  const invite = token
    ? await prisma.invite.findUnique({ where: { tokenHash: hashInviteToken(token) } })
    : inviteId
      ? await prisma.invite.findUnique({ where: { id: inviteId } })
      : null;

  if (!invite) redirect(back);

  // applyInvite enforces the email-match gate, single-use, expiry and revocation
  // atomically. Any non-success reason routes the user back to the invite view.
  const result = await applyInvite(invite, { id: user.id, email: user.email });
  if (!result.ok) redirect(back);

  redirect("/dashboard");
}
