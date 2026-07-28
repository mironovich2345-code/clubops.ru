import Link from "next/link";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { UserBadge } from "@/components/UserBadge";
import { canAnyRoleAccessPage, isStrategicRole } from "@/lib/auth";
import { getCurrentAccessContext, getUserCompanies, getUserClubs } from "@/lib/access";
import { NAV_ITEMS, ROLE_LABELS, STRATEGIC_HIDDEN_PAGES } from "@/lib/navigation";
import { logoutAction } from "@/app/auth-actions";
import { ScopeSwitcher } from "./_components/ScopeSwitcher";
import { MobileShell } from "./_components/MobileShell";
import { ThemeToggle } from "@/components/ThemeToggle";

// This layout reads the database and the session, so the whole (app) subtree
// must be rendered on demand, never statically prerendered at build time.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Effective-role gate: unauthenticated -> /login; no effective access -> /no-access.
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");
  if (!ctx.selectedCompanyId || ctx.effectiveRoles.length === 0) redirect("/onboarding");
  const user = ctx.user;

  // Strategic roles (owner / GD) keep route access but lose the operational
  // menu entries (Продажи, Сотрудники, История действий) from the sidebar.
  const strategic = isStrategicRole(ctx.effectiveRoles);
  const visibleItems = NAV_ITEMS.filter(
    (item) =>
      canAnyRoleAccessPage(ctx.effectiveRoles, item.page) &&
      !(strategic && STRATEGIC_HIDDEN_PAGES.includes(item.page)),
  );
  const roleLabel = ctx.effectiveRole ? ROLE_LABELS[ctx.effectiveRole] ?? ctx.effectiveRole : "";

  // Companies the user may switch between, and clubs within the active company.
  const [companies, clubs] = await Promise.all([
    getUserCompanies(user.id),
    getUserClubs(user.id, ctx.selectedCompanyId ?? undefined),
  ]);

  const scopeSlot =
    companies.length > 0 && ctx.selectedCompanyId ? (
      <ScopeSwitcher
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
        clubs={clubs.map((c) => ({ id: c.id, name: c.name }))}
        selectedCompanyId={ctx.selectedCompanyId}
        selectedClubId={ctx.selectedClubId}
      />
    ) : (
      <div className="text-sm text-slate-400">Нет доступной компании</div>
    );

  const accountSlot = (
    <div className="flex flex-wrap items-center gap-3">
      <UserBadge user={user} roleLabel={roleLabel} />
      <ThemeToggle />
      <Link href="/settings/security" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Безопасность</Link>
      <form action={logoutAction}>
        <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Выйти</button>
      </form>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Desktop sidebar — hidden below lg (mobile uses the drawer/bottom-nav shell). */}
      <div className="hidden lg:block">
        <Sidebar items={visibleItems} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Desktop header */}
        <header className="hidden h-16 items-center justify-between border-b border-slate-200 bg-white px-6 lg:flex">
          {scopeSlot}
          {accountSlot}
        </header>
        {/* Mobile shell: sticky top bar + drawer + bottom nav */}
        <MobileShell items={visibleItems.map((i) => ({ page: i.page, href: i.href, label: i.label }))} header={scopeSlot} account={accountSlot} />
        <main className="min-w-0 flex-1 px-4 py-4 pb-bottom-nav lg:px-8 lg:py-8 lg:pb-8">{children}</main>
      </div>
    </div>
  );
}
