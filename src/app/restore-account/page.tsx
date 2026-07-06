import { lookupByRecoveryToken, EMAIL_REUSE_MESSAGE } from "@/lib/account-restore";
import { RestoreFlow } from "./_components/RestoreFlow";

export const dynamic = "force-dynamic";

export default async function RestoreAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const lookup = token ? await lookupByRecoveryToken(token) : ({ ok: false, code: "invalid" } as const);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-4 text-lg font-semibold text-slate-900">Восстановление аккаунта</h1>
        {lookup.ok ? (
          <RestoreFlow token={token as string} masked={lookup.maskedEmail} />
        ) : (
          <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
            {lookup.code === "reused"
              ? EMAIL_REUSE_MESSAGE
              : lookup.code === "expired"
                ? "Срок восстановления истёк. Обратитесь к администратору системы CLUB-OPS."
                : "Ссылка восстановления недействительна. Обратитесь к администратору системы CLUB-OPS."}
          </div>
        )}
      </div>
    </div>
  );
}
