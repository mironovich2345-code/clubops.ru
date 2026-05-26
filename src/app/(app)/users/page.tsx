import { PageHeader } from "@/components/PageHeader";
import { PlaceholderCard } from "@/components/PlaceholderCard";
import { requirePageAccess } from "@/lib/auth";

export default async function UsersPage() {
  await requirePageAccess("users");

  return (
    <div>
      <PageHeader
        title="Пользователи"
        description="Сотрудники, роли и доступ к клубам."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlaceholderCard title="Список пользователей" hint="Таблица появится позже." />
        <PlaceholderCard title="Доступ к клубам" hint="Управление доступом по клубам." />
      </div>
    </div>
  );
}
