import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { formatKopeks } from "@/lib/money";
import { requirePageAccess, getCurrentAccessContext } from "@/lib/access";
import {
  getSalesReportForContext,
  availableSalesReportActions,
  canEditReport,
  salesReportWarnings,
  linesToMap,
  cashOooRemaining,
  cashReconciliation,
  SALES_REPORT_ROWS,
  REPORT_SECTIONS,
  CALC_HINT,
  ENCASHMENT_KEY,
  CASH_OOO_KEY,
  CASH_REMAINING_LABEL,
  REVENUE_LINE_KEY,
  SALES_REPORT_STATUS_LABELS,
  SALES_REPORT_STATUS_TONE,
  SALES_REPORT_DOC_TYPES,
  WITHDRAWAL_KEY,
  REVENUE_OOO_KEY,
  REVENUE_IP_KEY,
  type ReportSection,
} from "@/lib/sales-reports";
import { SalesReportActions } from "../../_components/SalesReportActions";
import { SalesReportDocSlots } from "../../_components/SalesReportDocSlots";

export const dynamic = "force-dynamic";

const dtFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const dtTimeFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

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
  const cashOoo = byKey[CASH_OOO_KEY] ?? 0;
  const encashment = byKey[ENCASHMENT_KEY] ?? 0;
  const cashRemaining = cashOooRemaining(cashOoo, encashment);
  const withdrawal = byKey[WITHDRAWAL_KEY] ?? 0;
  const revenueOoo = byKey[REVENUE_OOO_KEY] ?? 0;
  const revenueIp = byKey[REVENUE_IP_KEY] ?? 0;
  const recon = cashReconciliation({ cashOooKopeks: cashOoo, encashmentKopeks: encashment, withdrawalKopeks: withdrawal });
  const encashmentDoc = report.documents.find((d) => d.type === "encashment");
  // Count attached documents per type for the grouped display + warnings.
  const docsByType = new Map<string, typeof report.documents>();
  for (const d of report.documents) {
    const list = docsByType.get(d.type) ?? [];
    list.push(d);
    docsByType.set(d.type, list);
  }
  const docCount = (type: string) => docsByType.get(type)?.length ?? 0;
  const unmappedEntityRows = report.lines.filter(
    (l) => (ROW_META.get(l.key)?.section ?? "totals") !== "totals" && l.amountKopeks > 0 && !l.legalEntityId,
  ).length;
  const warnings = salesReportWarnings({
    cashOooKopeks: cashOoo,
    encashmentKopeks: encashment,
    encashmentDocCount: docCount("encashment"),
    unmappedEntityRows,
    withdrawalKopeks: withdrawal,
    withdrawalDocCount: docCount("withdrawal"),
    revenueOooKopeks: revenueOoo,
    oooReportDocCount: docCount("ooo_report"),
    revenueIpKopeks: revenueIp,
    ipReportDocCount: docCount("ip_report"),
  });
  // Which types must (важно) have a document given the amounts on this report.
  const requiredMissing = (type: string): boolean =>
    (type === "encashment" && encashment > 0 && docCount("encashment") === 0) ||
    (type === "withdrawal" && withdrawal > 0 && docCount("withdrawal") === 0);

  // Resolve verifier / rejecter names (stored as plain scalar ids).
  const actorIds = [report.verifiedByUserId, report.rejectedByUserId].filter((x): x is string => !!x);
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = (id: string | null) => (id ? actors.find((a) => a.id === id)?.name ?? "—" : "—");

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

      {/* Контроль наличности — сверка (Part 8) */}
      <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Контроль наличности
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-100 sm:grid-cols-4">
          <CashCell label="Общая выручка" value={formatKopeks(byKey[REVENUE_LINE_KEY] ?? 0)} />
          <CashCell label="Инкассация" value={formatKopeks(encashment)} />
          <CashCell label="Изъятия" value={formatKopeks(withdrawal)} />
          <CashCell
            label="Остаток наличности"
            value={formatKopeks(recon.remainingKopeks)}
            accent={recon.ok ? "text-emerald-700" : "text-rose-700"}
          />
        </div>
        <div className={`border-t px-4 py-2 text-sm font-medium ${recon.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          {recon.ok ? "✓ Сверка пройдена" : "⚠ Есть расхождение по наличности"}
        </div>
      </div>

      {/* Контроль наличности ООО */}
      <div className="mb-6 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Контроль наличности ООО
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-100 sm:grid-cols-4">
          <CashCell label="Наличные ООО" value={formatKopeks(cashOoo)} />
          <CashCell label="Инкассация ООО" value={formatKopeks(encashment)} />
          <CashCell
            label={CASH_REMAINING_LABEL}
            value={formatKopeks(cashRemaining)}
            accent={cashRemaining < 0 ? "text-rose-700" : "text-slate-900"}
          />
          <div className="bg-white px-4 py-3">
            <div className="text-xs text-slate-500">Документ инкассации</div>
            {encashmentDoc ? (
              <a
                href={`/api/sales-reports/${report.id}/file?key=${encodeURIComponent(encashmentDoc.storageKey ?? "")}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-sm font-medium text-brand-600 hover:text-brand-700"
              >
                Открыть документ
              </a>
            ) : encashment > 0 ? (
              <div className="mt-1 text-sm font-medium text-rose-600">Документ не приложен</div>
            ) : (
              <div className="mt-1 text-sm text-slate-400">—</div>
            )}
          </div>
        </div>
        {encashment > cashOoo ? (
          <div className="border-t border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700">
            Инкассация ООО больше наличной выручки ООО
          </div>
        ) : null}
        {encashment > 0 && !encashmentDoc ? (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            Для инкассации необходимо приложить документ
          </div>
        ) : null}
      </div>

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

        {/* Documents grouped by type (accountant sees what is attached vs missing) */}
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">Документы отчёта</div>
          <div className="divide-y divide-slate-100">
            {SALES_REPORT_DOC_TYPES.map((t) => {
              const docs = docsByType.get(t.key) ?? [];
              const mustHave = requiredMissing(t.key);
              return (
                <div key={t.key} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-700">{t.label}</span>
                    {docs.length === 0 ? (
                      mustHave ? (
                        <span className="text-xs font-medium text-rose-600">не приложен</span>
                      ) : (
                        <span className="text-xs text-slate-400">не приложен</span>
                      )
                    ) : (
                      <span className="text-xs text-emerald-600">{docs.length} файл(ов)</span>
                    )}
                  </div>
                  {docs.length > 0 ? (
                    <ul className="mt-1 space-y-1">
                      {docs.map((doc) => (
                        <li key={doc.id} className="text-sm">
                          <a
                            href={`/api/sales-reports/${report.id}/file?key=${encodeURIComponent(doc.storageKey ?? "")}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-600 hover:text-brand-700"
                          >
                            {doc.originalFileName}
                          </a>
                          <span className="ml-2 text-xs text-slate-400">{Math.round(doc.originalFileSize / 1024)} КБ</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
          {editable ? (
            <div className="border-t border-slate-100 p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Загрузить документы</div>
              <SalesReportDocSlots reportId={report.id} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Accountant verification */}
      {actions.length > 0 ? (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">Проверка бухгалтером</div>
          <SalesReportActions reportId={report.id} actions={actions} />
        </div>
      ) : null}

      {/* History */}
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 text-sm font-semibold text-slate-700">История</div>
        <ul className="space-y-3 text-sm">
          <li className="flex gap-2">
            <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-slate-400" />
            <div>
              <div className="font-medium text-slate-800">Создан</div>
              <div className="text-slate-600">
                {report.createdBy.name} · {dtTimeFormatter.format(report.createdAt)}
              </div>
            </div>
          </li>
          {report.status === "confirmed" && report.verifiedAt ? (
            <li className="flex gap-2">
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
              <div>
                <div className="font-medium text-emerald-700">Подтверждён</div>
                <div className="text-slate-600">
                  {nameOf(report.verifiedByUserId)} · {dtTimeFormatter.format(report.verifiedAt)}
                </div>
                {report.accountantComment ? (
                  <div className="mt-0.5 text-slate-500">Комментарий: {report.accountantComment}</div>
                ) : null}
              </div>
            </li>
          ) : null}
          {report.status === "rejected" && report.rejectedAt ? (
            <li className="flex gap-2">
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-rose-500" />
              <div>
                <div className="font-medium text-rose-700">Отклонён</div>
                <div className="text-slate-600">
                  {nameOf(report.rejectedByUserId)} · {dtTimeFormatter.format(report.rejectedAt)}
                </div>
                {report.rejectionReason ? (
                  <div className="mt-0.5 text-slate-500">Причина: {report.rejectionReason}</div>
                ) : null}
              </div>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function CashCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${accent ?? "text-slate-900"}`}>{value}</div>
    </div>
  );
}
