import { PageHeader } from "@/components/PageHeader";
import { NoCompanyState } from "@/components/NoCompanyState";
import {
  requirePageAccess,
  getCurrentCompanyAndClub,
  getCompanyMembers,
  getInvitableRoles,
  getManageableClubIds,
  getClubsInScope,
  userHasCompanyRole,
  assertCanManageUser,
  type CompanyMember,
} from "@/lib/access";
import { countActiveSessionsForUser } from "@/lib/session";
import { INVITE_ROLE_LABELS, deriveInviteStatus, INVITE_STATUS_LABELS, isClubScopedRole, type InviteStatus } from "@/lib/invites";
import { ROLE_LABELS } from "@/lib/navigation";
import { MobileDataCard } from "@/components/mobile/density";
import { StatusBadge } from "@/components/mobile/StatusBadge";
import { prisma } from "@/lib/prisma";
import { classifyRoleShape } from "@/lib/employee-roles";
import { InviteForm } from "./_components/InviteForm";
import { InviteRowActions } from "./_components/InviteRowActions";
import { UserAdminControls } from "./_components/UserAdminControls";
import { OwnerDeleteControl } from "./_components/OwnerDeleteControl";
import { RoleControls } from "./_components/RoleControls";
import { removeAccess } from "./actions";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const user = await requirePageAccess("users");

  const scope = await getCurrentCompanyAndClub(user);
  if (!scope.company) {
    return <NoCompanyState title="Пользователи" description="Сотрудники, роли и доступ к клубам" />;
  }
  const companyId = scope.company.id;
  const companyName = scope.company.name;

  const [members, invitableRoles, clubs, manageableClubIds, isOwner, isGeneralDirector] =
    await Promise.all([
      getCompanyMembers(companyId),
      getInvitableRoles(user.id, companyId),
      getClubsInScope(scope),
      getManageableClubIds(user.id, companyId),
      userHasCompanyRole(user.id, companyId, ["owner"]),
      userHasCompanyRole(user.id, companyId, ["general_director"]),
    ]);

  const manageable = new Set(manageableClubIds);
  const roleOptions = invitableRoles.map((value) => ({
    value,
    label: INVITE_ROLE_LABELS[value] ?? value,
  }));
  // Single source of truth for which invitable roles need a club (mirrors the
  // server's isClubScopedRole). The invite form uses this to drive its scope
  // control instead of hardcoding "manager".
  const clubScopedRoles = invitableRoles.filter((r) => isClubScopedRole(r));

  // Invitations visible to the actor: owner / general director see every invite
  // in the company; a regional director sees only invites for the clubs they
  // manage. Company-level invites are owner/GD-only.
  const canManageCompany = isOwner || isGeneralDirector;
  const inviteWhere = canManageCompany
    ? { companyId }
    : { companyId, clubId: { in: manageableClubIds } };
  const invites = manageableClubIds.length > 0 || canManageCompany
    ? await prisma.invite.findMany({
        where: inviteWhere,
        include: { club: { select: { name: true } }, invitedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const inviteRows = invites.map((inv) => ({
    id: inv.id,
    email: inv.email,
    roleLabel: INVITE_ROLE_LABELS[inv.role] ?? inv.role,
    clubName: inv.club?.name ?? null,
    invitedBy: inv.invitedBy.name,
    createdAt: inv.createdAt,
    lastSentAt: inv.lastSentAt,
    expiresAt: inv.expiresAt,
    status: deriveInviteStatus(inv),
  }));

  // Per-user active session counts + which users the actor may administer
  // (deactivate / revoke sessions). Computed per DISTINCT user.
  const distinctUserIds = [...new Set(members.map((m) => m.user.id))];
  const sessionCounts = new Map<string, number>();
  const adminUsers = new Set<string>();
  await Promise.all(
    distinctUserIds.map(async (uid) => {
      sessionCounts.set(uid, await countActiveSessionsForUser(uid));
      if (uid !== user.id) {
        const decision = await assertCanManageUser(user.id, uid, companyId);
        if (decision.ok) adminUsers.add(uid);
      }
    }),
  );
  // Show the per-user admin block once — on the FIRST access row of each user.
  // Precomputed (not a mutable set consumed during render) so the desktop table
  // and the mobile cards render independently and identically.
  const firstAccessIdByUser = new Map<string, string>();
  for (const m of members) if (!firstAccessIdByUser.has(m.user.id)) firstAccessIdByUser.set(m.user.id, m.accessId);
  const showsAdminBlock = (member: CompanyMember) =>
    adminUsers.has(member.user.id) && firstAccessIdByUser.get(member.user.id) === member.accessId;

  // GD-only manager↔regional conversions: per-user role shape + active clubs.
  const activeClubs = isGeneralDirector
    ? await prisma.club.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  const rolesByUser = new Map<string, string[]>();
  for (const m of members) rolesByUser.set(m.user.id, [...(rolesByUser.get(m.user.id) ?? []), m.role]);
  function roleShapeOf(uid: string): "manager" | "regional" | null {
    const shape = classifyRoleShape(rolesByUser.get(uid) ?? [], false);
    return shape === "manager" || shape === "regional" ? shape : null;
  }

  function canRemove(member: CompanyMember): boolean {
    if (member.user.id === user.id) return false; // no self-lockout
    if (member.scope === "company") {
      if (isOwner) return true;
      // General director manages operational roles, not owners/GDs.
      return isGeneralDirector && member.role !== "owner" && member.role !== "general_director";
    }
    return member.clubId !== null && manageable.has(member.clubId);
  }

  // Actions column — identical on desktop table + mobile card (spec §11: no critical
  // access info hidden behind overflow).
  const MemberActions = ({ member }: { member: CompanyMember }) => {
    const removable = canRemove(member);
    const showAdmin = showsAdminBlock(member);
    return (
      <div className="flex flex-col gap-2">
        {removable ? (
          <form action={removeAccess}>
            <input type="hidden" name="scope" value={member.scope} />
            <input type="hidden" name="accessId" value={member.accessId} />
            <button type="submit" className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-500/10 dark:text-rose-300">
              Удалить доступ
            </button>
          </form>
        ) : null}
        {showAdmin ? (
          <>
            <UserAdminControls targetUserId={member.user.id} isActive={member.user.isActive} sessionCount={sessionCounts.get(member.user.id) ?? 0} />
            {isGeneralDirector && member.user.isActive && roleShapeOf(member.user.id) ? (
              <RoleControls userId={member.user.id} userName={member.user.name} shape={roleShapeOf(member.user.id)!} clubs={activeClubs} />
            ) : null}
            {isOwner ? <OwnerDeleteControl targetUserId={member.user.id} /> : null}
          </>
        ) : null}
        {!removable && !adminUsers.has(member.user.id) ? <span className="text-xs text-slate-400">—</span> : null}
      </div>
    );
  };

  return (
    <div>
      <PageHeader title="Пользователи" description="Сотрудники, роли и доступ к клубам" />

      {roleOptions.length > 0 ? (
        <InviteForm roles={roleOptions} clubs={clubs} companyName={scope.company.name} clubScopedRoles={clubScopedRoles} />
      ) : null}

      {/* Mobile: cards (no clipped columns). Desktop: the full table. */}
      {members.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          Пока нет пользователей с доступом.
        </div>
      ) : (
        <div className="space-y-3 lg:hidden">
          {members.map((member) => (
            <MobileDataCard
              key={`m-${member.scope}-${member.accessId}`}
              title={member.user.name}
              badge={
                <StatusBadge tone={member.user.isActive ? "success" : "neutral"}>
                  {member.user.isActive ? "Активен" : "Отключён"}
                </StatusBadge>
              }
              rows={[
                { label: "Email", value: member.user.email },
                { label: "Роль", value: ROLE_LABELS[member.role] ?? member.role },
                { label: "Доступ", value: member.scope === "club" ? `Клуб: ${member.clubName}` : "Вся компания" },
                { label: "Компания", value: companyName },
              ]}
              footer={<MemberActions member={member} />}
            />
          ))}
        </div>
      )}

      <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:block dark:border-slate-800 dark:bg-slate-900">
        <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
          <thead className="bg-slate-50">
            <tr>
              <Th>Пользователь</Th>
              <Th>Роль</Th>
              <Th>Доступ</Th>
              <Th>Статус</Th>
              <Th>Действия</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {members.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">
                  Пока нет пользователей с доступом.
                </td>
              </tr>
            ) : (
              members.map((member) => (
                <tr key={`${member.scope}-${member.accessId}`} className="hover:bg-slate-50">
                  <Td>
                    <div className="font-medium text-slate-900">{member.user.name}</div>
                    <div className="text-xs text-slate-500">{member.user.email}</div>
                  </Td>
                  <Td>{ROLE_LABELS[member.role] ?? member.role}</Td>
                  <Td>
                    {member.scope === "club" ? `Клуб: ${member.clubName}` : "Вся компания"}
                  </Td>
                  <Td>
                    {member.user.isActive ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        Активен
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                        Отключён
                      </span>
                    )}
                  </Td>
                  <Td>
                    <MemberActions member={member} />
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {inviteRows.length > 0 ? (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Приглашения</h2>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th>Email</Th>
                  <Th>Роль</Th>
                  <Th>Доступ</Th>
                  <Th>Пригласил</Th>
                  <Th>Отправлено</Th>
                  <Th>Действует до</Th>
                  <Th>Статус</Th>
                  <Th>Действия</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {inviteRows.map((inv) => {
                  const actionable = inv.status !== "accepted" && inv.status !== "revoked";
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50">
                      <Td>{inv.email}</Td>
                      <Td>{inv.roleLabel}</Td>
                      <Td>{inv.clubName ? `Клуб: ${inv.clubName}` : "Вся компания"}</Td>
                      <Td>{inv.invitedBy}</Td>
                      <Td>{inv.lastSentAt ? inv.lastSentAt.toLocaleDateString("ru-RU") : "—"}</Td>
                      <Td>{inv.expiresAt.toLocaleDateString("ru-RU")}</Td>
                      <Td>
                        <InviteStatusBadge status={inv.status} />
                      </Td>
                      <Td>
                        {actionable ? (
                          <InviteRowActions inviteId={inv.id} canResend />
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const INVITE_STATUS_TONE: Record<InviteStatus, string> = {
  accepted: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  revoked: "bg-slate-100 text-slate-600 ring-slate-200",
  expired: "bg-amber-50 text-amber-700 ring-amber-200",
  email_failed: "bg-rose-50 text-rose-700 ring-rose-200",
  email_sent: "bg-sky-50 text-sky-700 ring-sky-200",
  pending: "bg-slate-50 text-slate-600 ring-slate-200",
};

function InviteStatusBadge({ status }: { status: InviteStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${INVITE_STATUS_TONE[status]}`}
    >
      {INVITE_STATUS_LABELS[status]}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 align-top text-sm text-slate-700">{children}</td>;
}
