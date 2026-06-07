import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import {
  getSalesReportForContext,
  availableSalesReportActions,
  canEditReport,
  salesReportWarnings,
  linesToMap,
  SALES_REPORT_ROWS,
  REPORT_SECTIONS,
  CALC_HINT,
  ENCASHMENT_KEY,
  REVENUE_LINE_KEY,
  SALES_REPORT_STATUS_LABELS,
  SALES_REPORT_STATUS_TONE,
  SALES_REPORT_DOC_TYPE_LABELS,
  type ReportSection,
} from "@/lib/sales-reports";
import { SalesReportActions } from "../../_components/SalesReportActions";
import { SalesReportDocUpload } from "../../_components/SalesReportDocUpload";

export const dynamic = "force-dynamic";

const dtFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

// key -> {section, calc} for grouping stored lines (legacy keys fall back).
const ROW_META = new Map(SALES_REPORT_ROWS.map((r) => [r.key, { section: r.section, calc: r.calc }]));

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
  const byKey = linesToMap(report.lines);
  const encashmentDocCount = report.documents.filter((d) => d.type === "encashment").length;
  const unmappedEntityRows = report.lines.filter(
    (l) => (ROW_META.get(l.key)?.section ?? "totals") !== "totals" && l.amountKopeks > 0 && !l.legalEntityId,
  ).length;
  const warnings = salesReportWarnings({
    encashmentKopeks: byKey[ENCASHMENT_KEY] ?? 0,
    encashmentDocCount,
    unmappedEntityRows,
  });

  const sectionRows = (section: ReportSection) =>
    report.lines.filter((l) => (ROW_META.get(l.key)?.section ?? "totals") === section);

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
        <span className="text-slate-500">Общая выручка: <span className="font-semibold text-slate-900">{formatKopeks(byKey[REVENUE_LINE_KEY] ?? 0)}</span></span>
        {report.status === "rejected" && report.rejectionReason ? (
          <span className="text-rose-700">Причина: {report.rejectionReason}</span>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <ul className="list-inside list-disc">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Indicators grouped by section */}
        <div className="space-y-4 lg:col-span-2">
          {REPORT_SECTIONS.map((section) => (
            <div key={section.key} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {section.label}
              </div>
              <table className="min-w-full divide-y divide-slate-100">
                <tbody>
                  {sectionRows(section.key).map((line) => {
                    const calc = ROW_META.get(line.key)?.calc ?? false;
                    const emphasize = line.key === REVENUE_LINE_KEY;
                    return (
                      <tr key={line.id} className={calc ? "bg-slate-50" : ""}>
                        <td className="px-4 py-1.5 text-sm">
                          <span className={emphasize ? "font-semibold text-slate-900" : calc ? "text-slate-600" : "text-slate-700"}>{line.label}</span>
                          {calc ? <span className="ml-2 text-[10px] text-slate-400">{CALC_HINT}</span> : null}
                        </td>
                        <td className={`px-4 py-1.5 text-right text-sm ${emphasize || calc ? "font-semibold text-slate-900" : "text-slate-700"}`}>
                          {formatKopeks(line.amountKopeks)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
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
                    <span className="mr-1 inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                      {SALES_REPORT_DOC_TYPE_LABELS[doc.type] ?? doc.type}
                    </span>
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

      {/* Accountant verification */}
      {actions.length > 0 ? (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">Проверка бухгалтером</div>
          <SalesReportActions reportId={report.id} actions={actions} />
        </div>
      ) : null}
    </div>
  );
}
