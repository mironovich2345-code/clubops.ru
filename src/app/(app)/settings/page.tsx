import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { requirePageAccess, getAccessibleClubsDetailed, type AccessibleClubRow } from "@/lib/access";
import { ROLE_LABELS } from "@/lib/navigation";
import { AddCompanyForm, CompanyEditor } from "./_components/SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requirePageAccess("settings");

  // Companies where the user is an owner (no cross-company leakage).
  const [access, accessibleClubs] = await Promise.all([
    prisma.companyUserAccess.findMany({
      where: { userId: user.id, role: "owner" },
      include: { company: { include: { clubs: { orderBy: { name: "asc" } } } } },
      orderBy: { company: { name: "asc" } },
    }),
    getAccessibleClubsDetailed(user),
  ]);
  const companies = [...new Map(access.map((a) => [a.companyId, a.company])).values()];

  return (
    <div>
      <PageHeader title="Настройки" description="Организации и клубы" />

      <div className="mb-8">
        <AvailableClubsSection clubs={accessibleClubs} />
      </div>

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
                clubs: company.clubs.map((c) => ({
                  id: c.id,
                  name: c.name,
                  city: c.city,
                  isActive: c.isActive,
                })),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AvailableClubsSection({ clubs }: { clubs: AccessibleClubRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
        Доступные клубы
      </div>
      {clubs.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-slate-500">
          У вас пока нет доступных клубов.
        </div>
      ) : (
        <table className="min-w-full divide-y divide-slate-200">
          <thead>
            <tr>
              <Th>Компания</Th>
              <Th>Клуб</Th>
              <Th>Город</Th>
              <Th>Роль</Th>
              <Th>Статус</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {clubs.map((c) => (
              <tr key={c.clubId} className="hover:bg-slate-50">
                <Td className="font-medium text-slate-900">{c.companyName}</Td>
                <Td>{c.clubName}</Td>
                <Td>{c.city}</Td>
                <Td>{c.role ? ROLE_LABELS[c.role] ?? c.role : "—"}</Td>
                <Td>
                  {c.isActive ? (
                    <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                      Активен
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                      В архиве
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
