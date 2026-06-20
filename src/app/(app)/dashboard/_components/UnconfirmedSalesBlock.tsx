import Link from "next/link";
import { formatKopeks } from "@/lib/money";

const CARD = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900";
const dtf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const dttf = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export type UnconfirmedRow = {
  id: string;
  companyId: string;
  companyName: string;
  clubId: string;
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
 * count / revenue / affected clubs / oldest pending, and up to five reports. No
 * verify/reject controls. When `safeOpenAction` is given (strategic multi-Company
 * view) rows submit a context-switch-and-open form (the report may belong to a
 * Company other than the active scope); otherwise a plain read-only link is used.
 */
export function UnconfirmedSalesBlock({
  rows,
  count,
  totalKopeks,
  clubsAffected,
  oldestDate,
  oldestAgeDays,
  monthLabel,
  showCompany = false,
  safeOpenAction,
}: {
  rows: UnconfirmedRow[];
  count: number;
  totalKopeks: number;
  clubsAffected: number;
  oldestDate: string | null;
  oldestAgeDays: number | null;
  monthLabel: string;
  showCompany?: boolean;
  safeOpenAction?: (formData: FormData) => void | Promise<void>;
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
            {rows.map((r) => {
              const inner = (
                <>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {dtf.format(new Date(r.reportDate))} · {r.clubName}
                      {showCompany ? <span className="ml-1 text-xs font-normal text-slate-400">· {r.companyName}</span> : null}
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
                </>
              );
              const rowCls = "flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/40";
              return safeOpenAction ? (
                <form key={r.id} action={safeOpenAction}>
                  <input type="hidden" name="target" value="sales_report" />
                  <input type="hidden" name="companyId" value={r.companyId} />
                  <input type="hidden" name="clubId" value={r.clubId} />
                  <input type="hidden" name="objectId" value={r.id} />
                  <button type="submit" className={rowCls}>{inner}</button>
                </form>
              ) : (
                <Link key={r.id} href={`/sales/reports/${r.id}`} className={rowCls}>
                  {inner}
                </Link>
              );
            })}
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
