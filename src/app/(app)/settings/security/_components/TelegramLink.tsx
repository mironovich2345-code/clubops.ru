"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { createTelegramLinkCode, unlinkTelegram } from "../telegram-actions";

type LinkState = { ok: boolean; error?: string; code?: string; startUrl?: string; expiresAt?: string };
const initial: LinkState = { ok: false };

function ConnectButton({ hasCode }: { hasCode: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? "Создание..." : hasCode ? "Создать новый код" : "Подключить Telegram"}
    </button>
  );
}

export function TelegramLink({
  enabled,
  connected,
  username,
  linkedAtLabel,
}: {
  enabled: boolean;
  connected: boolean;
  username: string | null;
  linkedAtLabel: string | null;
}) {
  const [state, formAction] = useFormState(createTelegramLinkCode, initial);
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-8">
      <div className="mb-2 text-sm font-semibold text-slate-700">Telegram-уведомления</div>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        {!enabled ? (
          <p className="text-sm text-slate-500">Telegram-уведомления сейчас недоступны. Обратитесь к администратору системы.</p>
        ) : connected ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="text-sm">
              <div className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                Telegram подключён
              </div>
              {username ? <div className="mt-2 text-slate-700">@{username}</div> : null}
              {linkedAtLabel ? <div className="mt-1 text-xs text-slate-500">Подключён: {linkedAtLabel}</div> : null}
            </div>
            <form action={unlinkTelegram}>
              <button
                type="submit"
                className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
              >
                Отключить Telegram
              </button>
            </form>
          </div>
        ) : (
          <div>
            <p className="text-sm text-slate-600">
              Подключите Telegram, чтобы получать уведомления о расходах, счетах и возвратах.
            </p>
            <div className="mt-3">
              <form action={formAction}>
                <ConnectButton hasCode={Boolean(state.ok && state.code)} />
              </form>
            </div>

            {state.error ? <p className="mt-3 text-sm text-rose-600">{state.error}</p> : null}

            {state.ok && state.code ? (
              <div className="mt-4 rounded-md bg-emerald-50 p-3 ring-1 ring-inset ring-emerald-200">
                <div className="text-sm font-medium text-emerald-800">
                  Код показывается один раз и действует 10 минут.
                </div>
                {state.startUrl ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <a
                      href={state.startUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
                    >
                      Открыть бота и нажать Start
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(state.startUrl!);
                        setCopied(true);
                      }}
                      className="rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                    >
                      {copied ? "Скопировано" : "Скопировать ссылку"}
                    </button>
                  </div>
                ) : null}
                <div className="mt-2 text-xs text-slate-600">
                  Код: <span className="font-mono">{state.code}</span>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Откройте бота в Telegram и нажмите «Start» — аккаунт подключится автоматически.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
