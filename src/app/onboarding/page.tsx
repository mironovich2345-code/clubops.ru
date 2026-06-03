import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCurrentAccessContext } from "@/lib/access";
import { OnboardingForm } from "./OnboardingForm";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // If the user already has access, they don't onboard — send them in.
  const ctx = await getCurrentAccessContext();
  if (ctx?.effectiveRole) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="text-xl font-semibold tracking-tight text-slate-900">Club Ops</div>
          <div className="mt-1 text-sm text-slate-500">Создание компании и первого клуба</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-1 text-lg font-semibold text-slate-900">Добро пожаловать!</h1>
          <p className="mb-4 text-sm text-slate-500">
            Создайте свою компанию и первый клуб — вы станете их владельцем.
          </p>
          <OnboardingForm />
        </div>
      </div>
    </div>
  );
}
