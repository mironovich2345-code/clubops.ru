"use client";

import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/**
 * Install helper (spec §10/§26). iOS Safari cannot auto-install — we show the manual
 * «На экран Домой» steps. Android/Chrome may fire `beforeinstallprompt` → we offer a real
 * «Установить» button. Hidden entirely when already running standalone. Never aggressive:
 * this renders only on the /install page (no popups elsewhere).
 */
export function InstallGuide() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const mm = window.matchMedia("(display-mode: standalone)");
    const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setStandalone(mm.matches || iosStandalone);
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as BeforeInstallPromptEvent); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (standalone) {
    return <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">CLUB-OPS уже запущен как приложение. Ничего устанавливать не нужно.</div>;
  }

  return (
    <div className="space-y-4">
      {deferred && !done ? (
        <button
          type="button"
          onClick={async () => { await deferred.prompt(); await deferred.userChoice; setDeferred(null); setDone(true); }}
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-brand-600 px-5 text-sm font-medium text-white hover:bg-brand-700 sm:w-auto"
        >
          Установить приложение
        </button>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold text-slate-800">iPhone (Safari)</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>Откройте CLUB-OPS в <b>Safari</b>.</li>
          <li>Нажмите значок <b>«Поделиться»</b>.</li>
          <li>Прокрутите меню.</li>
          <li>Выберите <b>«На экран „Домой“»</b>.</li>
          <li>Нажмите <b>«Добавить»</b>.</li>
          <li>Запускайте CLUB-OPS с новой иконки.</li>
        </ol>
        <p className="mt-2 text-xs text-amber-700">Установка на iPhone выполняется только через Safari (не Chrome).</p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 text-sm font-semibold text-slate-800">Android (Chrome)</div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>Нажмите «Установить приложение» выше (если доступно), или</li>
          <li>меню Chrome ⋮ → <b>«Установить приложение»</b> / «Добавить на главный экран».</li>
        </ol>
      </div>
    </div>
  );
}
