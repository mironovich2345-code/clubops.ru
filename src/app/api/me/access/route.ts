import { NextResponse } from "next/server";
import { getCurrentAccessContext } from "@/lib/access";
import { canAnyRoleAccessPage, canCreateOperational } from "@/lib/auth";

// Self-introspection: returns ONLY the authenticated caller's own resolved
// access context. No parameters, no other-user data — safe to expose. Useful for
// debugging "who am I / what can I do" and powering the manager-access smoke test.
export async function GET() {
  const ctx = await getCurrentAccessContext();
  if (!ctx) return NextResponse.json({ authenticated: false }, { status: 401 });

  return NextResponse.json({
    authenticated: true,
    userId: ctx.user.id,
    selectedCompanyId: ctx.selectedCompanyId,
    selectedClubId: ctx.selectedClubId,
    effectiveRole: ctx.effectiveRole,
    effectiveRoles: ctx.effectiveRoles,
    allowedClubIds: ctx.allowedClubIds,
    canCreateOperational: canCreateOperational(ctx.effectiveRoles),
    pages: {
      sales: canAnyRoleAccessPage(ctx.effectiveRoles, "sales"),
      expenses: canAnyRoleAccessPage(ctx.effectiveRoles, "expenses"),
      invoices: canAnyRoleAccessPage(ctx.effectiveRoles, "invoices"),
      refunds: canAnyRoleAccessPage(ctx.effectiveRoles, "refunds"),
    },
  });
}
