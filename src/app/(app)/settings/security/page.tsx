import { PageHeader } from "@/components/PageHeader";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { maskEmail } from "@/lib/otp";
import { emailConfigured } from "@/lib/email";
import { getCurrentSessionId, listActiveSessionsForUser } from "@/lib/session";
import { endOwnSession, endOtherOwnSessions, endAllOwnSessions } from "./actions";
import { DeleteAccountFlow } from "./_components/DeleteAccountFlow";
import { PersonalDataForm, PasswordChangeFlow, EmailChangeFlow } from "./_components/AccountForms";
import { TelegramLink } from "./_components/TelegramLink";
import { telegramEnabled } from "@/lib/telegram/config";
import { getActiveConnectionView } from "@/lib/telegram/linking";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

export default async function SecurityPage() {
  const user = await requireUser();
  const [sessions, currentId, profile, telegram] = await Promise.all([
    listActiveSessionsForUser(user.id),
    getCurrentSessionId(),
    prisma.user.findUnique({ where: { id: user.id }, select: { firstName: true, lastName: true, email: true, updatedAt: true } }),
    getActiveConnectionView(user.id),
  ]);
  const others = sessions.filter((s) => s.id !== currentId).length;
  const emailEnabled = emailConfigured();
  const maskedEmail = profile ? maskEmail(profile.email) : "";

  return (
    <div className="max-w-3xl">
      <PageHeader title="Безопасность" description="Личные данные, пароль, email и активные сессии" />

      {profile ? (
        <PersonalDataForm
          firstName={profile.firstName ?? ""}
          lastName={profile.lastName ?? ""}
          updatedAt={profile.updatedAt.toISOString()}
        />
      ) : null}
      <PasswordChangeFlow emailEnabled={emailEnabled} maskedEmail={maskedEmail} />
      <EmailChangeFlow emailEnabled={emailEnabled} maskedEmail={maskedEmail} />

      <TelegramLink
        enabled={telegramEnabled()}
        connected={telegram.connected}
        username={telegram.username}
        linkedAtLabel={telegram.linkedAt ? dateFmt.format(telegram.linkedAt) : null}
      />

      <div className="mt-8 mb-2 text-sm font-semibold text-slate-700">Активные сессии</div>

      <div className="mb-4 flex flex-wrap gap-2">
        <form action={endOtherOwnSessions}>
          <button
            type="submit"
            disabled={others === 0}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Завершить остальные сессии
          </button>
        </form>
        <form action={endAllOwnSessions}>
          <button
            type="submit"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
          >
            Завершить все сессии
          </button>
        </form>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Устройство</Th>
              <Th>Создана</Th>
              <Th>Активность</Th>
              <Th>Истекает</Th>
              <Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {sessions.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">Нет активных сессий.</td></tr>
            ) : (
              sessions.map((s) => {
                const isCurrent = s.id === currentId;
                return (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <Td>
                      <div className="font-medium text-slate-900">{s.deviceLabel}</div>
                      {isCurrent ? (
                        <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                          Текущая сессия
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">{dateFmt.format(s.createdAt)}</Td>
                    <Td className="whitespace-nowrap text-slate-600">{dateFmt.format(s.lastSeenAt)}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{dateFmt.format(s.expiresAt)}</Td>
                    <Td>
                      <form action={endOwnSession}>
                        <input type="hidden" name="sessionId" value={s.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {isCurrent ? "Завершить эту сессию" : "Завершить сессию"}
                        </button>
                      </form>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Завершение текущей сессии выполнит выход. Завершение всех сессий потребует повторного входа на всех устройствах.
      </p>

      <DeleteAccountFlow />
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-sm text-slate-700 ${className ?? ""}`}>{children}</td>;
}
