import { PageHeader } from "@/components/PageHeader";

// Shown when the current user has no accessible company/club in scope.
export function NoCompanyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <div className="rounded-lg border border-slate-200 bg-white p-10 text-center shadow-sm">
        <div className="text-sm font-medium text-slate-700">Нет доступной компании</div>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          У вашей учётной записи пока нет доступа ни к одной компании или клубу.
          Обратитесь к владельцу, чтобы он назначил доступ.
        </p>
      </div>
    </div>
  );
}
