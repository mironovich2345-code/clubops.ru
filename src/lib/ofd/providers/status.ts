// Aggregated per-provider OFD status for the unified «Подключение ОФД» overview and the
// dashboard multi-provider card. READ-ONLY: it only reads existing OfdConnection /
// OfdCashRegisterMapping / OfdSyncRun rows — no parallel sync, no new OFD contour, no
// duplicated provider logic. Each provider is independent.
import { prisma } from "@/lib/prisma";
import { ofdEnabled } from "@/lib/ofd/config";
import { listOfdProviders } from "@/lib/ofd/providers/registry";

export type OfdCardStatus =
  | "disabled"
  | "not_connected"
  | "needs_api_key"
  | "needs_setup"
  | "connected"
  | "attention"
  | "error"
  | "running";

export type OfdProviderCard = {
  id: string;
  label: string; // «ОФД Такском» / «ОФД Астрал»
  description: string;
  live: boolean; // provider is a real, working integration
  status: OfdCardStatus;
  statusLabel: string;
  connected: boolean;
  organizationCount: number;
  kktCount: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  manageHref: string;
};

const CARD_LABEL: Record<string, string> = { taxcom: "ОФД Такском", astral: "ОФД Астрал" };
const CARD_DESC: Record<string, string> = {
  taxcom: "Подключение чеков и касс через Такском",
  astral: "Подключение чеков и касс через Астрал.ОФД",
};
const MANAGE_HREF: Record<string, string> = {
  taxcom: "/settings/integrations/ofd",
  astral: "/settings/ofd/astral",
};

const STATUS_LABEL: Record<OfdCardStatus, string> = {
  disabled: "Отключено",
  not_connected: "Не подключено",
  needs_api_key: "Требует API-ключ",
  needs_setup: "Требует настройки",
  connected: "Подключено",
  attention: "Требует внимания",
  error: "Ошибка",
  running: "Выполняется",
};

const HEALTHY_WINDOW_HOURS = 30;

/** One card per registered provider (currently Такском live + Астрал skeleton). */
export async function loadOfdProviderCards(companyId: string, now: Date = new Date()): Promise<OfdProviderCard[]> {
  const enabled = ofdEnabled();
  const cards: OfdProviderCard[] = [];

  for (const provider of listOfdProviders()) {
    const conns = await prisma.ofdConnection.findMany({
      where: { companyId, provider: provider.id },
      select: { id: true, isActive: true, integrationTokenEncrypted: true, loginEncrypted: true, passwordEncrypted: true, lastSyncAt: true },
    });
    const active = conns.filter((c) => c.isActive);
    const connIds = conns.map((c) => c.id);
    const kktCount = connIds.length
      ? await prisma.ofdCashRegisterMapping.count({ where: { connectionId: { in: connIds }, isActive: true } })
      : 0;
    const [latestRun, lastSuccess] = connIds.length
      ? await Promise.all([
          prisma.ofdSyncRun.findFirst({ where: { connectionId: { in: connIds } }, orderBy: { createdAt: "desc" }, select: { status: true, finishedAt: true, startedAt: true, createdAt: true, safeErrorCode: true } }),
          prisma.ofdSyncRun.findFirst({ where: { connectionId: { in: connIds }, status: { in: ["success", "partial_failed"] } }, orderBy: { createdAt: "desc" }, select: { finishedAt: true, createdAt: true } }),
        ])
      : [null, null];

    const isLive = provider.status === "live";
    const hasSecret = active.some((c) =>
      isLive ? (c.loginEncrypted && c.passwordEncrypted) || c.integrationTokenEncrypted : Boolean(c.integrationTokenEncrypted),
    );
    const lastSuccessAt = lastSuccess?.finishedAt ?? lastSuccess?.createdAt ?? null;
    const lastAttemptAt = latestRun?.finishedAt ?? latestRun?.startedAt ?? latestRun?.createdAt ?? null;

    let status: OfdCardStatus;
    if (!enabled) {
      status = "disabled";
    } else if (active.length === 0) {
      status = conns.length > 0 && !isLive ? "needs_api_key" : "not_connected";
    } else if (!isLive) {
      // Astral skeleton: even with a stored key, live sync is not available yet.
      status = hasSecret ? "needs_setup" : "needs_api_key";
    } else if (latestRun && (latestRun.status === "pending" || latestRun.status === "running")) {
      status = "running";
    } else if (latestRun && latestRun.status === "failed") {
      status = "error";
    } else if (lastSuccessAt) {
      const ageH = (now.getTime() - lastSuccessAt.getTime()) / 3_600_000;
      status = ageH <= HEALTHY_WINDOW_HOURS ? "connected" : "attention";
    } else {
      status = "connected"; // configured, not yet synced
    }

    cards.push({
      id: provider.id,
      label: CARD_LABEL[provider.id] ?? provider.label,
      description: CARD_DESC[provider.id] ?? "",
      live: isLive,
      status,
      statusLabel: STATUS_LABEL[status],
      connected: active.length > 0 && status !== "needs_api_key" && status !== "not_connected",
      organizationCount: active.length,
      kktCount,
      lastAttemptAt: lastAttemptAt ? lastAttemptAt.toISOString() : null,
      lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
      lastErrorCode: latestRun?.safeErrorCode ?? null,
      manageHref: MANAGE_HREF[provider.id] ?? "/settings/ofd",
    });
  }
  return cards;
}
