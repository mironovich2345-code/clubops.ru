import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ensureDevOwner, DEV_DEMO_CREDENTIALS } from "@/lib/seed";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Dev/local only: make sure a demo owner exists so the beta is usable.
  await ensureDevOwner();

  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  const devHint = process.env.NODE_ENV !== "production" ? DEV_DEMO_CREDENTIALS : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-xl font-semibold tracking-tight text-slate-900">Club Ops</div>
          <div className="mt-1 text-sm text-slate-500">Вход в систему</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-4 text-lg font-semibold text-slate-900">Вход</h1>
          <LoginForm />
          <p className="mt-4 text-center text-sm text-slate-500">
            Нет аккаунта?{" "}
            <Link href="/register" className="font-medium text-brand-600 hover:text-brand-700">
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
