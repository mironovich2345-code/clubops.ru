// Honest offline fallback (precached by the service worker). Static, no data, no auth —
// shown when a navigation fails with no network. Never presents stale financial data.
export const dynamic = "force-static";

export const metadata = { title: "Нет подключения" };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 pb-safe pt-safe text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-900 text-lg font-extrabold tracking-tight text-white">
        <span>C</span><span className="text-brand-500">O</span>
      </div>
      <h1 className="text-lg font-semibold text-slate-900">Нет подключения к интернету</h1>
      <p className="text-sm text-slate-500">
        Данные не обновлены. CLUB-OPS — финансовая система и не показывает устаревшие суммы как
        актуальные. Проверьте соединение и повторите.
      </p>
      <a href="/" className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-brand-600 px-5 text-sm font-medium text-white hover:bg-brand-700">
        Повторить
      </a>
    </main>
  );
}
