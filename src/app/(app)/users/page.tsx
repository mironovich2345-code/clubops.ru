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
import { INVITE_ROLE_LABELS } from "@/lib/invites";
import { ROLE_LABELS } from "@/lib/navigation";
import { prisma } from "@/lib/prisma";
import { classifyRoleShape } from "@/lib/employee-roles";
import { InviteForm } from "./_components/InviteForm";
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
  // Show the per-user admin block once (on the first row of each user).
  const seenUser = new Set<string>();

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

  return (
    <div>
      <PageHeader title="Пользователи" description="Сотрудники, роли и доступ к клубам" />

      {roleOptions.length > 0 ? (
        <InviteForm roles={roleOptions} clubs={clubs} companyName={scope.company.name} />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
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
                    <div className="flex flex-col gap-2">
                      {canRemove(member) ? (
                        <form action={removeAccess}>
                          <input type="hidden" name="scope" value={member.scope} />
                          <input type="hidden" name="accessId" value={member.accessId} />
                          <button
                            type="submit"
                            className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
                          >
                            Удалить доступ
                          </button>
                        </form>
                      ) : null}
                      {(() => {
                        // Per-user admin block, rendered once per user.
                        if (seenUser.has(member.user.id)) return null;
                        seenUser.add(member.user.id);
                        if (!adminUsers.has(member.user.id)) return null;
                        return (
                          <>
                            <UserAdminControls
                              targetUserId={member.user.id}
                              isActive={member.user.isActive}
                              sessionCount={sessionCounts.get(member.user.id) ?? 0}
                            />
                            {isGeneralDirector && member.user.isActive && roleShapeOf(member.user.id) ? (
                              <RoleControls
                                userId={member.user.id}
                                userName={member.user.name}
                                shape={roleShapeOf(member.user.id)!}
                                clubs={activeClubs}
                              />
                            ) : null}
                            {isOwner ? <OwnerDeleteControl targetUserId={member.user.id} /> : null}
                          </>
                        );
                      })()}
                      {!canRemove(member) && !adminUsers.has(member.user.id) ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
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
