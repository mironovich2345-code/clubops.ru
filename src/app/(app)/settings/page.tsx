import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requirePageAccess } from "@/lib/access";
import { AddCompanyForm, CompanyEditor } from "./_components/SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requirePageAccess("settings");

  // Companies where the user is an owner (no cross-company leakage).
  const access = await prisma.companyUserAccess.findMany({
    where: { userId: user.id, role: "owner" },
    include: { company: { include: { clubs: { orderBy: { name: "asc" } } } } },
    orderBy: { company: { name: "asc" } },
  });
  const companies = [...new Map(access.map((a) => [a.companyId, a.company])).values()];

  return (
    <div>
      <PageHeader title="Настройки" description="Организации и клубы" />

      <div className="mb-6">
        <AddCompanyForm />
      </div>

      <div className="mb-3 text-sm font-semibold text-slate-700">Компании</div>
      {companies.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
          У вас пока нет организаций, где вы являетесь владельцем.
        </div>
      ) : (
        <div className="space-y-4">
          {companies.map((company) => (
            <CompanyEditor
              key={company.id}
              company={{
                id: company.id,
                name: company.name,
                clubs: company.clubs.map((c) => ({ id: c.id, name: c.name, city: c.city })),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
