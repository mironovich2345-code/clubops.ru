import { redirect } from "next/navigation";
import { getChallengeMaskedEmail } from "@/lib/login-challenge";
import { OTP_TTL_MS } from "@/lib/otp";
import { VerifyForm } from "./VerifyForm";

export const dynamic = "force-dynamic";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; e?: string }>;
}) {
  const { next, e } = await searchParams;

  // The temporary challenge cookie must be present and valid. Otherwise the
  // confirmation session has expired — send the user back to the password step.
  const maskedEmail = await getChallengeMaskedEmail();
  if (!maskedEmail) {
    redirect("/login?e=expired");
  }

  const minutes = Math.round(OTP_TTL_MS / 60000);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-xl font-semibold tracking-tight text-slate-900">Club Ops</div>
          <div className="mt-1 text-sm text-slate-500">Подтверждение входа</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="mb-2 text-lg font-semibold text-slate-900">Введите код</h1>
          <p className="mb-4 text-sm text-slate-600">
            Мы отправили шестизначный код на <span className="font-medium">{maskedEmail}</span>.
            Код действует {minutes} минут.
          </p>
          <VerifyForm next={next} sendError={e === "send"} />
        </div>
        <p className="mt-4 text-center text-xs text-slate-400">
          Никому не сообщайте код входа.
        </p>
      </div>
    </div>
  );
}
