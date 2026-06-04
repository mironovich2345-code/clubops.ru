import { redirect } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { UserBadge } from "@/components/UserBadge";
import { canAnyRoleAccessPage } from "@/lib/auth";
import { getCurrentAccessContext, getUserCompanies, getUserClubs } from "@/lib/access";
import { NAV_ITEMS, ROLE_LABELS } from "@/lib/navigation";
import { logoutAction } from "@/app/auth-actions";
import { ScopeSwitcher } from "./_components/ScopeSwitcher";

// This layout reads the database and the session, so the whole (app) subtree
// must be rendered on demand, never statically prerendered at build time.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Effective-role gate: unauthenticated -> /login; no effective access -> /no-access.
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");
  if (!ctx.selectedCompanyId || ctx.effectiveRoles.length === 0) redirect("/onboarding");
  const user = ctx.user;

  const visibleItems = NAV_ITEMS.filter((item) =>
    canAnyRoleAccessPage(ctx.effectiveRoles, item.page),
  );
  const roleLabel = ctx.effectiveRole ? ROLE_LABELS[ctx.effectiveRole] ?? ctx.effectiveRole : "";

  // Companies the user may switch between, and clubs within the active company.
  const [companies, clubs] = await Promise.all([
    getUserCompanies(user.id),
    getUserClubs(user.id, ctx.selectedCompanyId ?? undefined),
  ]);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar items={visibleItems} />
      <div className="flex flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
          {companies.length > 0 && ctx.selectedCompanyId ? (
            <ScopeSwitcher
              companies={companies.map((c) => ({ id: c.id, name: c.name }))}
              clubs={clubs.map((c) => ({ id: c.id, name: c.name }))}
              selectedCompanyId={ctx.selectedCompanyId}
              selectedClubId={ctx.selectedClubId}
            />
          ) : (
            <div className="text-sm text-slate-400">Нет доступной компании</div>
          )}
          <div className="flex items-center gap-3">
            <UserBadge user={user} roleLabel={roleLabel} />
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Выйти
              </button>
            </form>
          </div>
        </header>
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
