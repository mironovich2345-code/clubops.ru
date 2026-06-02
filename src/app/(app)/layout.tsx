import { Sidebar } from "@/components/Sidebar";
import { UserBadge } from "@/components/UserBadge";
import { getCurrentUser, canAccessPage } from "@/lib/auth";
import { ensureDemoData } from "@/lib/seed";
import { getUserCompanies, getUserClubs } from "@/lib/access";
import { NAV_ITEMS } from "@/lib/navigation";

// This layout reads the database (ensureDemoData + company/club context), so the
// whole (app) subtree must be rendered on demand, never statically prerendered
// at build time (the DB has no tables yet during a Railway build).
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  await ensureDemoData();

  const visibleItems = NAV_ITEMS.filter((item) => canAccessPage(user.role, item.page));

  const [companies, clubs] = await Promise.all([
    getUserCompanies(user.id),
    getUserClubs(user.id),
  ]);
  // Auto-select when there is only one option.
  const currentCompany = companies[0] ?? null;
  const currentClub = clubs[0] ?? null;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar items={visibleItems} />
      <div className="flex flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
          <ContextChips
            companyName={currentCompany?.name ?? null}
            companyCount={companies.length}
            clubName={currentClub?.name ?? null}
            clubCount={clubs.length}
          />
          <UserBadge user={user} />
        </header>
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}

function ContextChips({
  companyName,
  companyCount,
  clubName,
  clubCount,
}: {
  companyName: string | null;
  companyCount: number;
  clubName: string | null;
  clubCount: number;
}) {
  if (!companyName) return <div />;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-1 text-slate-700">
        <span className="text-xs text-slate-400">Компания</span>
        <span className="font-medium">{companyName}</span>
        {companyCount > 1 ? <span className="text-xs text-slate-400">+{companyCount - 1}</span> : null}
      </span>
      {clubName ? (
        <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-1 text-slate-700">
          <span className="text-xs text-slate-400">Клуб</span>
          <span className="font-medium">{clubName}</span>
          {clubCount > 1 ? <span className="text-xs text-slate-400">+{clubCount - 1}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
