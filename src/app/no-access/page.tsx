import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCurrentAccessContext } from "@/lib/access";
import { logoutAction } from "@/app/auth-actions";

export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // If access has since been granted, send them into the app.
  const ctx = await getCurrentAccessContext();
  if (ctx?.effectiveRole) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">Доступ не назначен</h1>
        <p className="mt-2 text-sm text-slate-600">
          Вы вошли как <span className="font-medium">{user.email}</span>, но у вашей учётной
          записи пока нет доступа ни к одной компании или клубу.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Попросите владельца компании отправить вам приглашение, затем откройте ссылку-приглашение.
        </p>
        <form action={logoutAction} className="mt-5">
          <button
            type="submit"
            className="w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Выйти
          </button>
        </form>
      </div>
    </div>
  );
}
