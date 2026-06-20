import Link from "next/link";
import { formatKopeks } from "@/lib/money";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dtf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const dttf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export type UnconfirmedRow = {
  id: string;
  clubName: string;
  reportDate: string; // ISO
  createdAt: string; // ISO
  managerName: string | null;
  createdByName: string;
  totalKopeks: number;
  oooKopeks: number;
  ipKopeks: number;
};

/**
 * Read-only "Неподтверждённые продажи" block for the Owner/GD dashboard. Shows
 * count / revenue / affected clubs / oldest pending, and up to five reports with
 * a link to the report detail (opened read-only). No verify/reject controls.
 */
export function UnconfirmedSalesBlock({
  rows,
  count,
  totalKopeks,
  clubsAffected,
  oldestDate,
  oldestAgeDays,
  monthLabel,
}: {
  rows: UnconfirmedRow[];
  count: number;
  totalKopeks: number;
  clubsAffected: number;
  oldestDate: string | null;
  oldestAgeDays: number | null;
  monthLabel: string;
}) {
  return (
    <div className={`mb-6 overflow-hidden ${CARD}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Неподтверждённые продажи</span>
        <span className="text-xs text-slate-400">{monthLabel}</span>
      </div>

      {count === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          Все отчёты за выбранный месяц подтверждены
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px bg-slate-100 dark:bg-slate-800 sm:grid-cols-4">
            <Stat label="Отчётов" value={String(count)} />
            <Stat label="Выручка" value={formatKopeks(totalKopeks)} />
            <Stat label="Клубов" value={String(clubsAffected)} />
            <Stat
              label="Старейший"
              value={oldestDate ? dtf.format(new Date(oldestDate)) : "—"}
              hint={oldestAgeDays !== null ? `${oldestAgeDays} дн.` : undefined}
            />
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/sales/reports/${r.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {dtf.format(new Date(r.reportDate))} · {r.clubName}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Менеджер: {r.managerName ?? r.createdByName} · создан {dttf.format(new Date(r.createdAt))}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{formatKopeks(r.totalKopeks)}</div>
                  <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    ООО {formatKopeks(r.oooKopeks)} · ИП {formatKopeks(r.ipKopeks)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {count > rows.length ? (
            <div className="px-4 py-2 text-center text-xs text-slate-400">… и ещё {count - rows.length}</div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white px-4 py-3 dark:bg-slate-900">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{value}</div>
      {hint ? <div className="text-[11px] text-slate-400">{hint}</div> : null}
    </div>
  );
}
