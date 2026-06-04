import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hashInviteToken, isInviteExpired, INVITE_ROLE_LABELS } from "@/lib/invites";
import { acceptInvite } from "./actions";

export const dynamic = "force-dynamic";

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const user = await getCurrentUser();

  // No token: a logged-in user can still accept invites addressed to their
  // email (this is where /onboarding redirects a zero-access invited user).
  if (!token) {
    if (!user) return <Shell>{<ErrorText text="Ссылка приглашения недействительна." />}</Shell>;
    const pending = await prisma.invite.findMany({
      where: { email: user.email.toLowerCase(), acceptedAt: null, expiresAt: { gt: new Date() } },
      include: { company: true, club: true },
      orderBy: { createdAt: "desc" },
    });
    if (pending.length === 0) {
      return <Shell>{<ErrorText text="Активных приглашений для вашего аккаунта нет." />}</Shell>;
    }
    return (
      <Shell>
        <p className="mb-4 text-sm text-slate-600">
          Приглашения для <span className="font-medium">{user.email}</span>:
        </p>
        <ul className="space-y-3">
          {pending.map((inv) => (
            <li key={inv.id} className="rounded-md border border-slate-200 p-3">
              <Details
                email={inv.email}
                roleLabel={INVITE_ROLE_LABELS[inv.role] ?? inv.role}
                scopeLabel={inv.club ? `клуб «${inv.club.name}»` : `компания «${inv.company.name}»`}
              />
              <form action={acceptInvite} className="mt-3">
                <input type="hidden" name="inviteId" value={inv.id} />
                <button
                  type="submit"
                  className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
                >
                  Принять приглашение
                </button>
              </form>
            </li>
          ))}
        </ul>
      </Shell>
    );
  }

  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { company: true, club: true },
  });

  if (!invite) return <Shell>{<ErrorText text="Приглашение не найдено." />}</Shell>;
  if (invite.acceptedAt) {
    return <Shell>{<ErrorText text="Это приглашение уже использовано." />}</Shell>;
  }
  if (isInviteExpired(invite.expiresAt)) {
    return <Shell>{<ErrorText text="Срок действия приглашения истёк." />}</Shell>;
  }

  const roleLabel = INVITE_ROLE_LABELS[invite.role] ?? invite.role;
  const scopeLabel = invite.club
    ? `клуб «${invite.club.name}»`
    : `компания «${invite.company.name}»`;

  if (!user) {
    // Carry the invite link through login/register so the user returns here.
    const back = `/accept-invite?token=${encodeURIComponent(token)}`;
    const loginHref = `/login?next=${encodeURIComponent(back)}`;
    const registerHref = `/register?next=${encodeURIComponent(back)}`;
    return (
      <Shell>
        <Details email={invite.email} roleLabel={roleLabel} scopeLabel={scopeLabel} />
        <p className="mt-4 text-sm text-slate-600">
          Войдите или зарегистрируйтесь под <span className="font-medium">{invite.email}</span> —
          после входа вы вернётесь сюда автоматически.
        </p>
        <div className="mt-4 flex gap-2">
          <Link
            href={loginHref}
            className="flex-1 rounded-md bg-brand-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-brand-700"
          >
            Вход
          </Link>
          <Link
            href={registerHref}
            className="flex-1 rounded-md border border-slate-300 bg-white px-4 py-2 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Регистрация
          </Link>
        </div>
      </Shell>
    );
  }

  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Shell>
        <ErrorText
          text={`Приглашение оформлено для ${invite.email}. Вы вошли как ${user.email} — войдите под нужным адресом.`}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <Details email={invite.email} roleLabel={roleLabel} scopeLabel={scopeLabel} />
      <form action={acceptInvite} className="mt-5">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
        >
          Принять приглашение
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-4 text-lg font-semibold text-slate-900">Приглашение</h1>
        {children}
      </div>
    </div>
  );
}

function Details({
  email,
  roleLabel,
  scopeLabel,
}: {
  email: string;
  roleLabel: string;
  scopeLabel: string;
}) {
  return (
    <dl className="space-y-2 text-sm">
      <Row label="Email" value={email} />
      <Row label="Роль" value={roleLabel} />
      <Row label="Доступ" value={scopeLabel} />
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function ErrorText({ text }: { text: string }) {
  return (
    <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
      {text}
    </div>
  );
}
