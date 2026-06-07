import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import {
  getSalesReportForContext,
  availableSalesReportActions,
  canEditReport,
  validateSalesReportLines,
  linesToMap,
  SALES_REPORT_STATUS_LABELS,
  SALES_REPORT_STATUS_TONE,
  REVENUE_LINE_KEY,
} from "@/lib/sales-reports";
import { SalesReportActions } from "../../_components/SalesReportActions";
import { SalesReportDocUpload } from "../../_components/SalesReportDocUpload";

export const dynamic = "force-dynamic";

const dtFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

export default async function SalesReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePageAccess("sales");
  const ctx = await getCurrentAccessContext();
  if (!ctx) notFound();

  const report = await getSalesReportForContext(ctx, id);
  if (!report) notFound();

  const isCreator = report.createdByUserId === ctx.user.id;
  const actions = availableSalesReportActions(report.status, ctx.effectiveRoles, isCreator);
  const editable = canEditReport(report.status, ctx.effectiveRoles, isCreator);
  const warnings = validateSalesReportLines(linesToMap(report.lines));

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <PageHeader title={`Сменный отчёт · ${dtFormatter.format(report.reportDate)}`} description={report.club.name} />
        <Link href="/sales" className="text-sm font-medium text-brand-600 hover:text-brand-700">← К продажам</Link>
      </div>

      {/* Meta + status */}
      <div className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm text-sm">
        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${SALES_REPORT_STATUS_TONE[report.status] ?? "bg-slate-100 text-slate-600 ring-slate-200"}`}>
          {SALES_REPORT_STATUS_LABELS[report.status] ?? report.status}
        </span>
        <span className="text-slate-500">Клуб: <span className="font-medium text-slate-900">{report.club.name}</span></span>
        <span className="text-slate-500">Менеджер: <span className="font-medium text-slate-900">{report.managerName ?? report.createdBy.name}</span></span>
        <span className="text-slate-500">Создал: <span className="font-medium text-slate-900">{report.createdBy.name}</span></span>
        {report.status === "rejected" && report.rejectionReason ? (
          <span className="text-rose-700">Причина: {report.rejectionReason}</span>
        ) : null}
      </div>

      {/* Validation warnings */}
      {warnings.length > 0 ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">Есть расхождения в отчёте</div>
          <ul className="mt-1 list-inside list-disc text-xs">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          Контрольные суммы сходятся
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Lines */}
        <div className="lg:col-span-2 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Показатели</div>
          <table className="min-w-full divide-y divide-slate-200">
            <tbody className="divide-y divide-slate-100">
              {report.lines.map((line) => {
                const isTotal = line.key === REVENUE_LINE_KEY;
                return (
                  <tr key={line.id} className={isTotal ? "bg-slate-50" : "hover:bg-slate-50"}>
                    <td className={`px-4 py-2 text-sm ${isTotal ? "font-semibold text-slate-900" : "text-slate-700"}`}>{line.label}</td>
                    <td className={`px-4 py-2 text-right text-sm ${isTotal ? "font-semibold text-slate-900" : "text-slate-700"}`}>{formatKopeks(line.amountKopeks)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Documents */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Документы</div>
          <div className="p-4">
            {report.documents.length === 0 ? (
              <div className="text-sm text-slate-500">Документы не прикреплены.</div>
            ) : (
              <ul className="space-y-1">
                {report.documents.map((doc) => (
                  <li key={doc.id}>
                    <a
                      href={`/api/sales-reports/${report.id}/file?key=${encodeURIComponent(doc.storageKey ?? "")}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-brand-600 hover:text-brand-700"
                    >
                      {doc.originalFileName}
                    </a>
                    <span className="ml-2 text-xs text-slate-400">{Math.round(doc.originalFileSize / 1024)} КБ</span>
                  </li>
                ))}
              </ul>
            )}
            {editable ? (
              <div className="mt-4 border-t border-slate-100 pt-4">
                <SalesReportDocUpload reportId={report.id} />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Actions */}
      {actions.length > 0 ? (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">Действия</div>
          <SalesReportActions reportId={report.id} actions={actions} />
        </div>
      ) : null}
    </div>
  );
}
