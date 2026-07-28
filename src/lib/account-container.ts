// Server-only multi-account (device-local) service. A browser holds ONE random
// httpOnly cookie — the container token. The container references several existing
// Session rows (by id) and points at the ACTIVE one; that active stored account
// drives the current user. This never introduces a second `club_ops_session` and
// never stores raw tokens (HMAC-only, like Session/SettingsPinSession).
//
// Security invariants:
//   - only hashToken(containerToken) is stored (tokenHash @unique);
//   - a stored account resolves to a user ONLY when its Session passes the SAME
//     validity gate as the single-session path (not revoked, not expired, user
//     active) — so a revoked/expired session or a deactivated user auto-neutralizes;
//   - switch/remove ALWAYS verify the stored row belongs to the caller's container
//     (never trust a submitted id);
//   - the container's own cookie is httpOnly, so client JS cannot read/rebind it.
//
// The `*Record` functions carry all the DB/security logic and take explicit ids
// (no cookies) so they are unit-testable against the dev DB. The cookie wrappers
// below read/write the container cookie and delegate to them.
import "server-only";
import { cookies, headers } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import type { Session, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";

export const ACCOUNTS_COOKIE = "club_ops_accounts";
const CONTAINER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ContainerAuth = { governs: boolean; value: { session: Session; user: User } | null };

// Same validity gate as session.ts isValid(): a session drives a user only when it
// is not revoked, not expired, and its owner is active. Kept inline to avoid a
// module cycle with session.ts (which imports resolveContainerAuth from here).
function sessionRowValid(s: (Session & { user: User }) | null): boolean {
  if (!s) return false;
  if (s.revokedAt) return false;
  if (s.expiresAt.getTime() < Date.now()) return false;
  if (!s.user || !s.user.isActive) return false;
  return true;
}

function newContainerToken(): string {
  return randomBytes(32).toString("hex");
}

// --- DB-level (cookie-free, testable) --------------------------------------

export async function createContainerRecord(token: string, meta?: { deviceLabel?: string | null; userAgentHash?: string | null }) {
  const expiresAt = new Date(Date.now() + CONTAINER_TTL_MS);
  const c = await prisma.accountSessionContainer.create({
    data: { tokenHash: hashToken(token), expiresAt, deviceLabel: meta?.deviceLabel ?? null, userAgentHash: meta?.userAgentHash ?? null },
  });
  return { id: c.id, expiresAt };
}

/** A valid (not revoked, not expired) container by raw token, else null. */
export async function getContainerByToken(token: string) {
  const c = await prisma.accountSessionContainer.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!c || c.revokedAt || c.expiresAt.getTime() < Date.now()) return null;
  return c;
}

/** Attach/refresh a stored account for (container,user) → sessionId, and make it active. */
export async function attachSessionToContainerRecord(containerId: string, userId: string, sessionId: string) {
  const existingCount = await prisma.storedAccountSession.count({ where: { containerId } });
  const stored = await prisma.storedAccountSession.upsert({
    where: { containerId_userId: { containerId, userId } },
    create: { containerId, userId, sessionId, displayOrder: existingCount, lastUsedAt: new Date() },
    update: { sessionId, revokedAt: null, lastUsedAt: new Date() },
  });
  await prisma.accountSessionContainer.update({ where: { id: containerId }, data: { activeStoredSessionId: stored.id, lastActiveAt: new Date() } });
  return stored;
}

/** Resolve the active session+user from a container token (or null). Ownership of the
 *  active stored row against its container is enforced. */
export async function resolveActiveSession(token: string): Promise<{ session: Session; user: User } | null> {
  const c = await getContainerByToken(token);
  if (!c || !c.activeStoredSessionId) return null;
  const stored = await prisma.storedAccountSession.findUnique({ where: { id: c.activeStoredSessionId } });
  if (!stored || stored.containerId !== c.id || stored.revokedAt) return null;
  const session = await prisma.session.findUnique({ where: { id: stored.sessionId }, include: { user: true } });
  if (!sessionRowValid(session)) return null;
  return { session: session!, user: session!.user };
}

/** Switch the active account. Ownership-checked; a revoked/expired target is refused
 *  (the caller must re-login that account — spec §7, no silent auto-switch). */
export async function switchActiveAccountRecord(containerId: string, storedId: string): Promise<{ ok: boolean; error?: "not_found" | "revoked" | "expired" }> {
  const stored = await prisma.storedAccountSession.findUnique({ where: { id: storedId } });
  if (!stored || stored.containerId !== containerId) return { ok: false, error: "not_found" }; // ownership guard
  if (stored.revokedAt) return { ok: false, error: "revoked" };
  const session = await prisma.session.findUnique({ where: { id: stored.sessionId }, include: { user: true } });
  if (!sessionRowValid(session)) return { ok: false, error: "expired" };
  await prisma.storedAccountSession.update({ where: { id: storedId }, data: { lastUsedAt: new Date() } });
  await prisma.accountSessionContainer.update({ where: { id: containerId }, data: { activeStoredSessionId: storedId, lastActiveAt: new Date() } });
  return { ok: true };
}

/** Remove one account from the device: soft-revoke its stored row AND its Session;
 *  if it was active, repoint to the next; report whether the container is now empty. */
export async function removeStoredAccountRecord(containerId: string, storedId: string): Promise<{ ok: boolean; nextActiveId: string | null; empty: boolean }> {
  const stored = await prisma.storedAccountSession.findUnique({ where: { id: storedId } });
  if (!stored || stored.containerId !== containerId) return { ok: false, nextActiveId: null, empty: false };
  await prisma.storedAccountSession.update({ where: { id: storedId }, data: { revokedAt: new Date() } });
  await prisma.session.updateMany({ where: { id: stored.sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "account_removed_from_device" } });

  const container = await prisma.accountSessionContainer.findUnique({ where: { id: containerId } });
  let nextActiveId = container?.activeStoredSessionId ?? null;
  if (container?.activeStoredSessionId === storedId) {
    const next = await prisma.storedAccountSession.findFirst({ where: { containerId, revokedAt: null, id: { not: storedId } }, orderBy: { lastUsedAt: "desc" } });
    nextActiveId = next?.id ?? null;
    await prisma.accountSessionContainer.update({ where: { id: containerId }, data: { activeStoredSessionId: nextActiveId } });
  }
  const remaining = await prisma.storedAccountSession.count({ where: { containerId, revokedAt: null } });
  const empty = remaining === 0;
  if (empty) await prisma.accountSessionContainer.update({ where: { id: containerId }, data: { revokedAt: new Date(), activeStoredSessionId: null } });
  return { ok: true, nextActiveId, empty };
}

/** Logout ALL: revoke the container + every stored account + their Sessions. */
export async function logoutAllRecord(containerId: string): Promise<number> {
  const stored = await prisma.storedAccountSession.findMany({ where: { containerId, revokedAt: null }, select: { sessionId: true } });
  const ids = stored.map((s) => s.sessionId);
  if (ids.length > 0) {
    await prisma.session.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: "logout_all_accounts" } });
  }
  await prisma.storedAccountSession.updateMany({ where: { containerId, revokedAt: null }, data: { revokedAt: new Date() } });
  await prisma.accountSessionContainer.update({ where: { id: containerId }, data: { revokedAt: new Date(), activeStoredSessionId: null } });
  return ids.length;
}

export type AccountSummary = {
  storedId: string;
  userId: string;
  name: string;
  email: string;
  active: boolean;
  status: "active" | "needs_login";
};

/** Safe per-account summary for the switcher UI — name/email/status only, never
 *  tokens or other accounts' data (spec §29). */
export async function listContainerAccountsRecord(containerId: string): Promise<AccountSummary[]> {
  const container = await prisma.accountSessionContainer.findUnique({ where: { id: containerId } });
  const stored = await prisma.storedAccountSession.findMany({ where: { containerId, revokedAt: null }, orderBy: { displayOrder: "asc" } });
  const out: AccountSummary[] = [];
  for (const s of stored) {
    const session = await prisma.session.findUnique({ where: { id: s.sessionId }, include: { user: true } });
    const user = session?.user ?? (await prisma.user.findUnique({ where: { id: s.userId } }));
    const valid = sessionRowValid(session ?? null);
    out.push({
      storedId: s.id,
      userId: s.userId,
      name: user?.name ?? "—",
      email: user?.email ?? "",
      active: container?.activeStoredSessionId === s.id,
      status: valid ? "active" : "needs_login",
    });
  }
  return out;
}

// --- Cookie wrappers (server-only) -----------------------------------------

function uaHash(ua: string | null): string | null {
  return ua ? createHash("sha256").update(ua).digest("hex").slice(0, 32) : null;
}

async function readContainerToken(): Promise<string | null> {
  return (await cookies()).get(ACCOUNTS_COOKIE)?.value ?? null;
}

async function setContainerCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(ACCOUNTS_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: expiresAt });
}

async function clearContainerCookie() {
  (await cookies()).delete(ACCOUNTS_COOKIE);
}

// Company/club scope cookies are per-browser, not per-account — clear them on any
// account change so account A's selected company never bleeds into account B (§14/§16).
async function clearScopeCookies() {
  const store = await cookies();
  store.delete("scope_company");
  store.delete("scope_club");
}

/**
 * Resolution entrypoint for getValidSession. When a valid container cookie is
 * present the container GOVERNS (returns the active account, or null if that
 * account's session expired — do NOT fall through to the legacy cookie, §7). Only
 * when there is no container / it is revoked/expired does the caller use the
 * single-session cookie path.
 */
export async function resolveContainerAuth(): Promise<ContainerAuth> {
  const token = await readContainerToken();
  if (!token) return { governs: false, value: null };
  const container = await getContainerByToken(token);
  if (!container) {
    await clearContainerCookie(); // dead container cookie — drop it, use legacy path
    return { governs: false, value: null };
  }
  return { governs: true, value: await resolveActiveSession(token) };
}

/** Add the just-created session (userId) as an account on this device, creating the
 *  container on first use, and make it active. Returns the stored account id. */
export async function addAccountSession(sessionId: string, userId: string): Promise<string> {
  let token = await readContainerToken();
  let container = token ? await getContainerByToken(token) : null;
  if (!container) {
    token = newContainerToken();
    let ua: string | null = null;
    try { ua = (await headers()).get("user-agent"); } catch { ua = null; }
    const created = await createContainerRecord(token, { deviceLabel: null, userAgentHash: uaHash(ua) });
    await setContainerCookie(token, created.expiresAt);
    container = await getContainerByToken(token);
  }
  const stored = await attachSessionToContainerRecord(container!.id, userId, sessionId);
  await clearScopeCookies();
  return stored.id;
}

/** After a NORMAL login: if this device already has a container, attach the new
 *  session to it (re-login updates that one account and makes it active, §7). No
 *  container ⇒ legacy single-account login, nothing to do. */
export async function attachToExistingContainer(sessionId: string, userId: string): Promise<void> {
  const token = await readContainerToken();
  const container = token ? await getContainerByToken(token) : null;
  if (!container) return;
  await attachSessionToContainerRecord(container.id, userId, sessionId);
  await clearScopeCookies();
}

async function currentContainerId(): Promise<string | null> {
  const token = await readContainerToken();
  if (!token) return null;
  return (await getContainerByToken(token))?.id ?? null;
}

export async function switchAccount(storedId: string): Promise<{ ok: boolean; error?: string }> {
  const containerId = await currentContainerId();
  if (!containerId) return { ok: false, error: "no_container" };
  const res = await switchActiveAccountRecord(containerId, storedId);
  if (res.ok) await clearScopeCookies();
  return res;
}

export async function removeAccount(storedId: string): Promise<{ ok: boolean; empty: boolean }> {
  const containerId = await currentContainerId();
  if (!containerId) return { ok: false, empty: false };
  const res = await removeStoredAccountRecord(containerId, storedId);
  await clearScopeCookies();
  if (res.empty) await clearContainerCookie();
  return { ok: res.ok, empty: res.empty };
}

/** Sign out the ACTIVE account only: revoke its session + remove it from the device,
 *  repointing to the next account (or clearing the container when none remain). Used
 *  by the generic "Выйти" so it never revokes a stale/other session in container mode. */
export async function removeActiveAccount(): Promise<{ empty: boolean }> {
  const containerId = await currentContainerId();
  if (!containerId) return { empty: true };
  const container = await prisma.accountSessionContainer.findUnique({ where: { id: containerId } });
  const activeId = container?.activeStoredSessionId ?? null;
  if (!activeId) { await clearContainerCookie(); await clearScopeCookies(); return { empty: true }; }
  const res = await removeStoredAccountRecord(containerId, activeId);
  await clearScopeCookies();
  if (res.empty) await clearContainerCookie();
  return { empty: res.empty };
}

export async function logoutAllAccounts(): Promise<void> {
  const containerId = await currentContainerId();
  if (containerId) await logoutAllRecord(containerId);
  await clearContainerCookie();
  await clearScopeCookies();
}

export async function listDeviceAccounts(): Promise<AccountSummary[]> {
  const containerId = await currentContainerId();
  if (!containerId) return [];
  return listContainerAccountsRecord(containerId);
}

// --- Add-account intent + login completion ---------------------------------

const ADD_INTENT_COOKIE = "club_ops_add_account";

/** Mark that the next successful login should ADD an account (not replace). Set when
 *  the user taps «Добавить аккаунт»; short-lived, httpOnly. */
export async function setAddAccountIntent(): Promise<void> {
  (await cookies()).set(ADD_INTENT_COOKIE, "1", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 15 * 60 });
}

async function consumeAddAccountIntent(): Promise<boolean> {
  const store = await cookies();
  const has = store.get(ADD_INTENT_COOKIE)?.value === "1";
  if (has) store.delete(ADD_INTENT_COOKIE);
  return has;
}

/**
 * Wire a freshly-created login session into the device container. Called right after
 * createSession in the OTP verify step:
 *   - add-account intent  → force a container (creating it on first use) and attach +
 *     activate the new account, leaving other accounts active (§5);
 *   - otherwise           → attach only if a container already exists (re-login of one
 *     account, §7); a single-account device stays container-free (zero regression).
 */
export async function completeLoginAttach(sessionId: string, userId: string): Promise<{ added: boolean }> {
  if (await consumeAddAccountIntent()) {
    await addAccountSession(sessionId, userId);
    return { added: true };
  }
  await attachToExistingContainer(sessionId, userId);
  return { added: false };
}

/** Snapshot the CURRENT account into a container (creating it if needed) before an
 *  add-account login, so the existing account is preserved and stays active until the
 *  new one signs in. */
export async function ensureCurrentAccountStored(sessionId: string, userId: string): Promise<void> {
  await addAccountSession(sessionId, userId);
}
