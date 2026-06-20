"use client";

type PlanRow = { clubName: string; month: string; total: string; subscriptions: string; personal: string };

/**
 * Read-only per-club sales plans (общий / абонементы / персональные).
 * The Excel import of plans has been removed from public workflows; plans are
 * entered via the manual plan form above. (Service/IT bulk import will be wired
 * to the platform IT Specialist contour in a later task.)
 */
export function SalesPlanImport({ rows }: { rows: PlanRow[] }) {
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <div className="mb-3 text-sm font-semibold text-slate-700">Планы продаж по клубам</div>

      {rows.length > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3 text-left">Клуб</th>
                <th className="py-2 pr-3 text-left">Месяц</th>
                <th className="py-2 pr-3 text-right">Общий</th>
                <th className="py-2 pr-3 text-right">Абонементы</th>
                <th className="py-2 text-right">Персональные</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, i) => (
                <tr key={i} className="text-sm text-slate-700">
                  <td className="py-2 pr-3 font-medium text-slate-900">{row.clubName}</td>
                  <td className="py-2 pr-3 text-slate-500">{row.month}</td>
                  <td className="py-2 pr-3 text-right">{row.total}</td>
                  <td className="py-2 pr-3 text-right">{row.subscriptions}</td>
                  <td className="py-2 text-right">{row.personal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">Планы по клубам ещё не заданы. Задайте план в форме выше.</p>
      )}
    </div>
  );
}
