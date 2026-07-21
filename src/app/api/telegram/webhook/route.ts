import { NextResponse } from "next/server";
import { telegramWebhookSecret } from "@/lib/telegram/config";
import { secretEquals } from "@/lib/secure-compare";
import { consumeLinkCode } from "@/lib/telegram/linking";
import { answerTelegramWebhookMessage } from "@/lib/telegram/client";

export const dynamic = "force-dynamic";

// Telegram delivers bot updates here. The full payload is NEVER logged. Access is
// gated by the X-Telegram-Bot-Api-Secret-Token header (set at setWebhook time);
// without a configured secret the endpoint refuses everything. Only /start [code]
// and /help are handled — anything else gets a short hint.
export async function POST(req: Request) {
  const secret = telegramWebhookSecret();
  // Fail-closed + constant-time: no server secret or wrong header → 403.
  if (!secretEquals(req.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = (update as { message?: Record<string, unknown> })?.message;
  const chat = msg?.chat as { id?: unknown; username?: string; first_name?: string; last_name?: string } | undefined;
  const from = msg?.from as { username?: string; first_name?: string; last_name?: string } | undefined;
  const chatId = chat?.id != null ? String(chat.id) : null;
  const text = typeof msg?.text === "string" ? (msg.text as string).trim() : "";
  if (!chatId) return NextResponse.json({ ok: true });

  const chatInfo = {
    chatId,
    username: chat?.username ?? from?.username ?? null,
    firstName: chat?.first_name ?? from?.first_name ?? null,
    lastName: chat?.last_name ?? from?.last_name ?? null,
  };

  if (text === "/start" || text.startsWith("/start ") || text.startsWith("/start@")) {
    const code = text.replace(/^\/start(@\S+)?/, "").trim();
    if (!code) {
      await answerTelegramWebhookMessage(chatId, "Откройте CLUB-OPS → Безопасность → Подключить Telegram и используйте одноразовую ссылку.");
      return NextResponse.json({ ok: true });
    }
    const outcome = await consumeLinkCode(code, chatInfo);
    await answerTelegramWebhookMessage(
      chatId,
      outcome.ok
        ? "Telegram подключён к CLUB-OPS. Теперь вы будете получать уведомления."
        : "Код недействителен или истёк. Создайте новый код в CLUB-OPS.",
    );
    return NextResponse.json({ ok: true });
  }

  if (text === "/help" || text.startsWith("/help")) {
    await answerTelegramWebhookMessage(
      chatId,
      "CLUB-OPS присылает уведомления о расходах, счетах и возвратах. Подключение: CLUB-OPS → Безопасность → Подключить Telegram.",
    );
    return NextResponse.json({ ok: true });
  }

  await answerTelegramWebhookMessage(chatId, "Команда не распознана. Откройте CLUB-OPS → Безопасность для подключения Telegram.");
  return NextResponse.json({ ok: true });
}
