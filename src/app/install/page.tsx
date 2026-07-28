import { InstallGuide } from "@/components/pwa/InstallGuide";

export const dynamic = "force-static";
export const metadata = { title: "Установить CLUB-OPS" };

// Public install guide (spec §26). No auth required — reachable before/after login. Standalone
// mode hides the steps (handled inside InstallGuide).
export default function InstallPage() {
  return (
    <main className="mx-auto max-w-md px-4 pb-safe pt-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 text-base font-extrabold tracking-tight text-white">
          <span>C</span><span className="text-brand-500">O</span>
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Добавить CLUB-OPS на телефон</h1>
          <p className="text-xs text-slate-500">Запуск с иконки, полноэкранный режим, быстрый доступ.</p>
        </div>
      </div>
      <InstallGuide />
      <p className="mt-4 text-center text-xs text-slate-400"><a href="/" className="hover:underline">← Вернуться</a></p>
    </main>
  );
}
