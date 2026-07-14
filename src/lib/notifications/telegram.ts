// Builds SAFE, plain-text Telegram messages from an outbox payload. The payload
// carries ONLY non-sensitive fields (resource type/id, club name, amount) — never
// documents, requisites, client names, phones, comments, OCR text or storage
// keys. The deep link is built from APP_URL.
import { absoluteUrlSafe } from "@/lib/app-url";

export type NotificationPayload = {
  resourceType: "expense" | "invoice" | "refund";
  clubName: string;
  amountKopeks: number;
};

const TITLES: Record<string, string> = {
  "expense.submitted_review": "Новый расход на проверку",
  "expense.resubmitted_review": "Расход повторно отправлен на проверку",
  "expense.returned": "Расход вернули на исправление",
  "expense.approved": "Расход согласован региональным",
  "invoice.submitted_review": "Новый счёт на проверку",
  "invoice.resubmitted_review": "Счёт повторно отправлен на проверку",
  "invoice.returned": "Счёт вернули на исправление",
  "invoice.approved": "Счёт согласован региональным",
  "refund.submitted_review": "Новый возврат на проверку",
  "refund.resubmitted_review": "Возврат повторно отправлен на проверку",
  "refund.returned": "Возврат вернули на исправление",
  "refund.approved": "Возврат согласован региональным",
};

/** Compact rubles: "21 356 ₽" (no kopecks, no PII). */
function rub(kopeks: number): string {
  const rubles = Math.round(kopeks / 100);
  return `${rubles.toLocaleString("ru-RU")} ₽`;
}

function pathFor(resourceType: NotificationPayload["resourceType"], resourceId: string): string {
  return `/${resourceType}s/${resourceId}`;
}

export type BuiltMessage = { text: string; openUrl: string | null };

/**
 * Build the message text + deep link for an outbox row. Unknown types fall back
 * to a neutral title. Returned/approved add a short "open in CLUB-OPS" hint but
 * never the actual comment/reason.
 */
export function buildTelegramMessage(type: string, resourceId: string, payload: NotificationPayload): BuiltMessage {
  const title = TITLES[type] ?? "Уведомление CLUB-OPS";
  const lines = [title, "", `Клуб: ${payload.clubName}`, `Сумма: ${rub(payload.amountKopeks)}`];
  if (type.endsWith(".submitted_review") || type.endsWith(".resubmitted_review")) {
    lines.push("Отправил: управляющий");
  }
  if (type.endsWith(".returned")) {
    lines.push("", "Откройте CLUB-OPS, чтобы посмотреть комментарий.");
  }
  return { text: lines.join("\n"), openUrl: absoluteUrlSafe(pathFor(payload.resourceType, resourceId)) };
}
