import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentAccessContext, userHasCompanyRole } from "@/lib/access";
import { ofdEnabled } from "@/lib/ofd/config";
import { loadOfdProviderCards, type OfdCardStatus } from "@/lib/ofd/providers/status";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const TONE: Record<OfdCardStatus, string> = {
  connected: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  running: "bg-sky-50 text-sky-700 ring-sky-200",
  attention: "bg-amber-50 text-amber-800 ring-amber-200",
  needs_setup: "bg-amber-50 text-amber-800 ring-amber-200",
  needs_api_key: "bg-amber-50 text-amber-800 ring-amber-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  not_connected: "bg-slate-100 text-slate-600 ring-slate-200",
  disabled: "bg-slate-100 text-slate-500 ring-slate-200",
};

const fmtWhen = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "—");

export default async function OfdOverviewPage() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/settings");
  const companyId = ctx.selectedCompanyId;
  // Overview is owner / general director (same band as the Настройки → Интеграции block).
  if (!(await userHasCompanyRole(ctx.user.id, companyId, ["owner", "general_director"]))) redirect("/settings");

  const cards = await loadOfdProviderCards(companyId);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-700">← Назад в настройки</Link>
      </div>
      <PageHeader
        title="Подключение ОФД"
        description="Подключите оператора фискальных данных, выберите организации, кассы и привяжите их к клубам"
      />

      {!ofdEnabled() ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Интеграции ОФД сейчас отключены (переменная OFD_INTEGRATIONS_ENABLED). Обратитесь к администратору системы.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {cards.map((c) => (
          <div key={c.id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-900">{c.label}</div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE[c.status]}`}>{c.statusLabel}</span>
            </div>
            <div className="mb-3 text-xs text-slate-500">{c.description}</div>

            <dl className="mb-4 space-y-1 text-xs text-slate-500">
              <Row label="Организаций" value={String(c.organizationCount)} />
              <Row label="Касс" value={String(c.kktCount)} />
              <Row label="Последняя синхронизация" value={fmtWhen(c.lastSuccessAt)} />
              {!c.live ? <div className="pt-1 text-[11px] text-amber-600">Интеграция в подготовке — нужны реквизиты оператора.</div> : null}
            </dl>

            <div className="mt-auto">
              <Link
                href={c.manageHref}
                className="inline-flex items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
              >
                {c.connected ? "Управление подключением" : "Подключить"}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="font-medium text-slate-700">{value}</dd>
    </div>
  );
}
