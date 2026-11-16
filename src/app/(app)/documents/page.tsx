import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import { canAnyRoleAccessPage, type AppPage } from "@/lib/auth";

export const dynamic = "force-dynamic";

const SOURCES: { page: AppPage; href: string; title: string; description: string }[] = [
  {
    page: "expenses",
    href: "/expenses",
    title: "Чеки и подтверждения расходов",
    description: "Откройте запись расхода, чтобы просмотреть приложенные чеки и подтверждения.",
  },
  {
    page: "invoices",
    href: "/invoices",
    title: "Счета и документы поставщиков",
    description: "В карточке счёта доступны исходные файлы и история согласования.",
  },
  {
    page: "refunds",
    href: "/refunds",
    title: "Заявления и документы возвратов",
    description: "Откройте доступный возврат, чтобы увидеть его документы и этапы согласования.",
  },
];

export default async function DocumentsPage() {
  await requirePageAccess("documents");
  const context = await getCurrentAccessContext();
  const sources = SOURCES.filter((source) => canAnyRoleAccessPage(context?.effectiveRoles ?? [], source.page));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Документы" description="Документы привязаны к соответствующим финансовым операциям." />
      <div className="mb-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]">
        В демоверсии доступны вымышленные документы внутри расходов, счетов и возвратов. Для безопасности единый поиск по всем вложениям и загрузка новых файлов отключены.
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {sources.map((source) => (
          <Link
            key={source.page}
            href={source.href}
            className="flex min-h-36 flex-col justify-between gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 text-[var(--text-primary)] shadow-sm hover:border-[var(--accent-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
          >
            <span>
              <span className="block text-base font-semibold">{source.title}</span>
              <span className="mt-2 block text-sm leading-6 text-[var(--text-secondary)]">{source.description}</span>
            </span>
            <span className="text-sm font-semibold text-[var(--accent-primary)]">Перейти к операциям →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
