import { Sidebar } from "@/components/Sidebar";
import { UserBadge } from "@/components/UserBadge";
import { getCurrentUser, canAccessPage } from "@/lib/auth";
import { NAV_ITEMS } from "@/lib/navigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const visibleItems = NAV_ITEMS.filter((item) => canAccessPage(user.role, item.page));

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar items={visibleItems} />
      <div className="flex flex-1 flex-col">
        <header className="flex h-16 items-center justify-end border-b border-slate-200 bg-white px-6">
          <UserBadge user={user} />
        </header>
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
