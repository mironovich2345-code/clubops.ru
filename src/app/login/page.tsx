import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ensureDevOwner, DEV_DEMO_CREDENTIALS } from "@/lib/seed";
import { safeNextPath } from "@/lib/safe-redirect";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; e?: string; deleted?: string; restored?: string }>;
}) {
  // Dev/local only: make sure a demo owner exists so the beta is usable.
  await ensureDevOwner();

  const { next, e, deleted, restored } = await searchParams;
  const user = await getCurrentUser();
  if (user) redirect(safeNextPath(next));

  const registerHref = next ? `/register?next=${encodeURIComponent(next)}` : "/register";
  const devHint = process.env.NODE_ENV !== "production" ? DEV_DEMO_CREDENTIALS : null;
  const notice =
    deleted === "1" ? "Аккаунт удалён. Ссылка для восстановления отправлена на email (действует 30 дней)."
    : restored === "1" ? "Аккаунт восстановлен. Войдите с паролем и кодом из email."
    : e === "expired" ? "Сеанс подтверждения истёк. Войдите снова."
    : e === "locked" ? "Слишком много попыток. Войдите снова."
    : e === "created" ? "Аккаунт создан. Войдите и подтвердите вход кодом из email."
    : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-xl font-semibold tracking-tight text-slate-900">Club Ops</div>
          <div className="mt-1 text-sm text-slate-500">Вход в систему</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-4 text-lg font-semibold text-slate-900">Вход</h1>
          {notice ? (
            <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
              {notice}
            </div>
          ) : null}
          <LoginForm next={next} />
          <p className="mt-4 text-center text-sm text-slate-500">
            Нет аккаунта?{" "}
            <Link href={registerHref} className="font-medium text-brand-600 hover:text-brand-700">
              Регистрация
            </Link>
          </p>
        </div>
        {devHint ? (
          <p className="mt-4 text-center text-xs text-slate-400">
            Демо-доступ (только локально): {devHint.email} / {devHint.password}
          </p>
        ) : null}
      </div>
    </div>
  );
}
