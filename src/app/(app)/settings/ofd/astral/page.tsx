import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole } from "@/lib/access";
import { ofdEnabled } from "@/lib/ofd/config";
import { getSettingsPinStatus } from "@/lib/settings-pin";
import { AstralApiKeyForm, AstralTestConnection } from "./_components/AstralForms";
import { AstralOrgStep, AstralOutletStep, AstralKktStep, AstralImportStep } from "./_components/AstralSteps";

export const dynamic = "force-dynamic";
const CARD = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

export default async function AstralOfdPage() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/settings");
  const companyId = ctx.selectedCompanyId;
  if (!(await userHasCompanyRole(ctx.user.id, companyId, ["owner", "general_director"]))) redirect("/settings");

  const conn = await prisma.ofdConnection.findFirst({
    where: { companyId, provider: "astral" },
    select: { id: true, isActive: true, integrationTokenEncrypted: true, externalOrganizationId: true, legalEntityId: true },
  });
  const hasKey = Boolean(conn?.integrationTokenEncrypted);
  const orgSelected = Boolean(conn?.externalOrganizationId);
  const pin = await getSettingsPinStatus(companyId, ctx.user.id);
  const pinNeeded = pin.configured && !pin.verified;

  const [legalEntities, clubs, mappings] = await Promise.all([
    prisma.legalEntity.findMany({ where: { companyId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.club.findMany({ where: { companyId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.ofdCashRegisterMapping.findMany({
      where: { companyId, provider: "astral", isActive: true, activeMappingKey: { not: null } },
      select: { fnNumber: true, kktFactoryNumber: true, kktName: true, clubId: true, legalEntityId: true },
    }),
  ]);
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const leName = new Map(legalEntities.map((l) => [l.id, l.name]));
  const boundKkts = mappings.map((m) => ({
    fnNumber: m.fnNumber,
    label: m.kktFactoryNumber || m.kktName || m.fnNumber,
    clubName: clubName.get(m.clubId) ?? "—",
    legalName: m.legalEntityId ? leName.get(m.legalEntityId) ?? "—" : "—",
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <nav className="mb-3 text-sm text-slate-500">
        <Link href="/settings" className="hover:text-slate-700">Настройки</Link>
        <span className="mx-1.5">→</span>
        <Link href="/settings/ofd" className="hover:text-slate-700">ОФД</Link>
        <span className="mx-1.5">→</span>
        <span className="text-slate-700">ОФД Астрал</span>
      </nav>
      <div className="mb-3">
        <Link href="/settings/ofd" className="text-sm text-slate-500 hover:text-slate-700">← Назад к провайдерам</Link>
      </div>
      <PageHeader title="ОФД Астрал" description="Подключение чеков и касс через Астрал.ОФД (только владелец / ген. директор)" />

      {!ofdEnabled() ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Интеграции ОФД сейчас отключены (OFD_INTEGRATIONS_ENABLED). Обратитесь к администратору системы.
        </div>
      ) : null}

      <div className="mb-6 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        Интеграция Астрал.ОФД реализована по официальной документации (v4.2). Статус — <b>READY FOR CREDENTIALS</b>:
        реальные запросы (организации, кассы, чеки) выполнятся, как только будет сохранён действующий API-ключ и пройдёт
        проверка подключения. До первого реального успешного импорта провайдер не помечается как «Подключено».
      </div>

      {pinNeeded ? (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Изменение ключа и привязки требует подтверждения ПИН настроек. Откройте
          <Link href="/settings/security" className="mx-1 text-brand-600 hover:text-brand-700">Настройки → Безопасность</Link>
          и введите ПИН.
        </div>
      ) : null}

      {/* Шаг 1 — API-ключ */}
      <Step n={1} title="API-ключ" status={hasKey ? "Ключ сохранён" : "Не задан"} active>
        <p className="mb-3 text-xs text-slate-500">Вставьте API-ключ Астрал.ОФД. Ключ хранится в зашифрованном виде (AES-256-GCM) и не отображается. Пустое поле при сохранении — оставить прежний ключ.</p>
        <AstralApiKeyForm hasKey={hasKey} />
        <AstralTestConnection />
      </Step>

      {/* Шаг 2 — Организация */}
      <Step n={2} title="Организация" status={orgSelected ? "Выбрана" : "Не выбрана"} active={hasKey}>
        {hasKey ? (
          <AstralOrgStep legalEntities={legalEntities} boundOrganizationId={conn?.externalOrganizationId ?? null} boundLegalEntityId={conn?.legalEntityId ?? null} />
        ) : <Locked hint="Сначала сохраните API-ключ (шаг 1)." />}
      </Step>

      {/* Шаг 3 — Торговая точка */}
      <Step n={3} title="Торговая точка" status={orgSelected ? "Доступно" : "—"} active={orgSelected}>
        {orgSelected ? <AstralOutletStep /> : <Locked hint="Сначала выберите организацию (шаг 2)." />}
      </Step>

      {/* Шаг 4 — Кассы */}
      <Step n={4} title="Кассы" status={boundKkts.length ? `Привязано: ${boundKkts.length}` : "Не привязаны"} active={orgSelected}>
        {orgSelected ? (
          <AstralKktStep legalEntities={legalEntities} clubs={clubs} boundLegalEntityId={conn?.legalEntityId ?? null} boundKkts={boundKkts} />
        ) : <Locked hint="Сначала выберите организацию (шаг 2)." />}
      </Step>

      {/* Шаг 5 — Тестовая синхронизация */}
      <Step n={5} title="Тестовая синхронизация" status={boundKkts.length ? "Доступно" : "—"} active={boundKkts.length > 0}>
        {boundKkts.length ? (
          <AstralImportStep boundKkts={boundKkts.map((k) => ({ fnNumber: k.fnNumber, label: k.label }))} defaultDate={ofdTodayMoscow()} />
        ) : <Locked hint="Сначала привяжите хотя бы одну кассу (шаг 4)." />}
      </Step>

      <div className="mt-6 text-xs text-slate-500">
        Документация: docs/integrations/astral-ofd-implementation.md · endpoints v4.2 (organization.list, kkt.aliasList,
        kkt.search, kkt.listByAlias, documents.tickets).
      </div>
    </div>
  );
}

function Step({ n, title, status, active, children }: { n: number; title: string; status: string; active: boolean; children: React.ReactNode }) {
  return (
    <div className={`mb-4 ${CARD} ${active ? "" : "opacity-70"}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800">Шаг {n}. {title}</div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{status}</span>
      </div>
      {children}
    </div>
  );
}

function Locked({ hint }: { hint: string }) {
  return <p className="text-xs text-slate-500">{hint}</p>;
}

/** Today's date (YYYY-MM-DD) in the OFD business timezone Europe/Moscow (UTC+3). */
function ofdTodayMoscow(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
}
