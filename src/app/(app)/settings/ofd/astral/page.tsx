import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { getCurrentAccessContext, userHasCompanyRole } from "@/lib/access";
import { ofdEnabled } from "@/lib/ofd/config";
import { getSettingsPinStatus } from "@/lib/settings-pin";
import { AstralProvider } from "@/lib/ofd/providers/astral-provider";
import { AstralApiKeyForm, AstralTestConnection } from "./_components/AstralForms";

export const dynamic = "force-dynamic";
const CARD = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

export default async function AstralOfdPage() {
  const ctx = await getCurrentAccessContext();
  if (!ctx || !ctx.selectedCompanyId) redirect("/settings");
  const companyId = ctx.selectedCompanyId;
  if (!(await userHasCompanyRole(ctx.user.id, companyId, ["owner", "general_director"]))) redirect("/settings");

  const conn = await prisma.ofdConnection.findFirst({ where: { companyId, provider: "astral" }, select: { id: true, isActive: true, integrationTokenEncrypted: true } });
  const hasKey = Boolean(conn?.integrationTokenEncrypted);
  const pin = await getSettingsPinStatus(companyId, ctx.user.id);
  const pinNeeded = pin.configured && !pin.verified;

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

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Интеграция Астрал.ОФД в подготовке. Сейчас доступно сохранение API-ключа и проверка подключения. Реальный
        импорт чеков заработает после подтверждённой документации и действующих реквизитов оператора
        (шаги «Организация», «Торговая точка», «Кассы», «Тестовая синхронизация» пока недоступны).
      </div>

      {pinNeeded ? (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Для изменения ключа и подключения требуется подтверждение ПИН настроек. Откройте
          <Link href="/settings/security" className="mx-1 text-brand-600 hover:text-brand-700">Настройки → Безопасность</Link>
          и введите ПИН.
        </div>
      ) : null}

      {/* Шаг 1 — API-ключ */}
      <Step n={1} title="API-ключ" status={hasKey ? "Ключ сохранён" : "Не задан"}>
        <p className="mb-3 text-xs text-slate-500">Вставьте API-ключ Астрал.ОФД. Ключ хранится в зашифрованном виде и не отображается. Пустое поле при сохранении — оставить прежний ключ.</p>
        <AstralApiKeyForm hasKey={hasKey} />
        <AstralTestConnection />
      </Step>

      {/* Шаги 2–5 — заготовка (активируются после реального подключения) */}
      <StepDisabled n={2} title="Организация" hint="Выбор организации Астрал (по данным organization.list) и привязка к юрлицу CLUB-OPS." />
      <StepDisabled n={3} title="Торговая точка" hint="Выбор торговой точки (kkt.aliasList) и привязка к клубу." />
      <StepDisabled n={4} title="Кассы" hint="Выбор касс (kkt.search / kkt.listByAlias) и привязка каждой к клубу и юрлицу." />
      <StepDisabled n={5} title="Тестовая синхронизация" hint="Импорт малого периода (1–3 дня): документы, приход, возвраты, наличные/электронные — с предпросмотром перед подтверждением." />

      <div className="mt-6 text-xs text-slate-500">
        Статус интеграции: <span className="font-medium text-amber-700">{AstralProvider.status === "blocked_by_documentation" ? "BLOCKED BY DOCUMENTATION" : AstralProvider.status}</span>.
        Что нужно от Астрал.ОФД — см. docs/integrations/astral-ofd-discovery.md.
      </div>
    </div>
  );
}

function Step({ n, title, status, children }: { n: number; title: string; status: string; children: React.ReactNode }) {
  return (
    <div className={`mb-4 ${CARD}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800">Шаг {n}. {title}</div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{status}</span>
      </div>
      {children}
    </div>
  );
}

function StepDisabled({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className={`mb-4 opacity-60 ${CARD}`}>
      <div className="mb-1 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800">Шаг {n}. {title}</div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Недоступно</span>
      </div>
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );
}
