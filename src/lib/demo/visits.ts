import "server-only";
import { randomBytes, createHmac } from "node:crypto";
import { Prisma, type DemoVisit } from "@prisma/client";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { createSession, getValidSession, revokeCurrentSession } from "@/lib/session";
import { assertDemoRequest, demoConfig, DEMO_ROLES, DEMO_TTL_MS, type DemoRole } from "./config";
import { seedDemoTenant } from "./fixtures";

export const DEMO_COOKIE = "club_ops_demo";
const digest = (value: string) => createHmac("sha256", process.env.SESSION_SECRET!).update(`demo:${value}`).digest("hex");

export async function currentDemoVisit(): Promise<DemoVisit | null> {
  demoConfig();
  const token = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const visit = await prisma.demoVisit.findUnique({ where: { tokenHash: digest(token) } });
  return visit && visit.expiresAt > new Date() ? visit : null;
}

// Child-first removal driven only by generated model metadata, never client input.
// Company-scoped tables without Prisma relations (OFD, audit) are included too.
// Cascading child documents follow their parent. FK failures roll back the purge.
export async function purgeDemoVisit(tx: Prisma.TransactionClient, visit: DemoVisit) {
  demoConfig();
  const models = Prisma.dmmf.datamodel.models.filter((m) => m.name !== "DemoVisit" && (m.name === "Company" || m.fields.some((f) => f.name === "companyId")));
  const pending = new Map(models.map((m) => [m.name, m]));
  while (pending.size) {
    const leaves = [...pending.values()].filter((parent) => ![...pending.values()].some((child) => child.name !== parent.name && child.fields.some((f) => f.kind === "object" && f.type === parent.name && f.relationFromFields?.length)));
    if (!leaves.length) throw new Error("DEMO_PURGE_DEPENDENCY_CYCLE");
    for (const m of leaves) {
      // Identifiers originate in Prisma DMMF, companyId is always bound.
      const column = m.name === "Company" ? "id" : "companyId";
      await tx.$executeRawUnsafe(`DELETE FROM "${m.name}" WHERE "${column}" = $1`, visit.companyId);
      pending.delete(m.name);
    }
  }
  const ids = Object.values(JSON.parse(visit.usersJson)) as string[];
  await tx.user.deleteMany({ where: { id: { in: ids } } });
  await tx.demoVisit.delete({ where: { id: visit.id } });
}

export async function cleanupDemoVisits() {
  demoConfig();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(784123091)`;
    const expired = await tx.demoVisit.findMany({ where: { expiresAt: { lte: new Date() } }, take: 30 });
    for (const visit of expired) await purgeDemoVisit(tx, visit);
    await tx.rateLimitBucket.deleteMany({ where: { action: "demo_entry", expiresAt: { lt: new Date() } } });
    return expired.length;
  }, { timeout: 60_000 });
}

/** Uses ordinary sessions, users and scoped role grants. No auth/scope bypass. */
export async function openDemoVisit(roleValue: string, clubIndex: number, reset = false) {
  const h = await headers();
  const config = assertDemoRequest(h.get("host"), h.get("origin"));
  if (!DEMO_ROLES.includes(roleValue as DemoRole) || !Number.isInteger(clubIndex) || clubIndex < 0 || clubIndex > 2) throw new Error("DEMO_SELECTION_INVALID");
  const role = roleValue as DemoRole;
  let visit = await currentDemoVisit();
  // A cookie alone must not let a different logged-in account control a visit.
  if (visit) {
    const current = await getValidSession();
    if (current && !Object.values(JSON.parse(visit.usersJson)).includes(current.user.id)) throw new Error("DEMO_SESSION_MISMATCH");
  }
  const oldVisit = reset ? visit : null;
  const rawToken = randomBytes(32).toString("hex");
  if (!visit || reset) {
    visit = await prisma.$transaction(async (tx) => {
      // Serializes admission across instances: global resource cap + fail-closed limiter.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(784123091)`;
      const expired = await tx.demoVisit.findMany({ where: { expiresAt: { lte: new Date() } }, take: 5 });
      for (const v of expired) await purgeDemoVisit(tx, v);
      const now = Date.now();
      const windowStart = new Date(Math.floor(now / 3_600_000) * 3_600_000);
      // Forwarded IP is trusted only behind the deployment ingress; global cap
      // still bounds admission even if a client can influence forwarding headers.
      const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      const key = digest(`admission:${ip}:${windowStart.toISOString()}`);
      const bucket = await tx.rateLimitBucket.upsert({ where: { bucketKey: key }, create: { bucketKey: key, action: "demo_entry", windowStart, expiresAt: new Date(windowStart.getTime() + 3_600_000), count: 1 }, update: { count: { increment: 1 } } });
      if (bucket.count > 6 || await tx.demoVisit.count() >= 30) throw new Error("DEMO_CAPACITY_LIMIT");
      if (oldVisit) await purgeDemoVisit(tx, oldVisit);
      const fixture = await seedDemoTenant(tx);
      return tx.demoVisit.create({ data: { tokenHash: digest(rawToken), companyId: fixture.companyId, usersJson: JSON.stringify(fixture.users), clubsJson: JSON.stringify(fixture.clubs), expiresAt: new Date(now + DEMO_TTL_MS) } });
    }, { timeout: 60_000, maxWait: 10_000 });
    (await cookies()).set(DEMO_COOKIE, rawToken, { httpOnly: true, sameSite: "lax", secure: !config.local, path: "/", expires: visit.expiresAt });
  }
  const users = JSON.parse(visit.usersJson) as Record<DemoRole, string>;
  const clubs = JSON.parse(visit.clubsJson) as string[];
  if (role === "manager") await prisma.$transaction(async (tx) => {
    await tx.clubUserAccess.deleteMany({ where: { userId: users.manager } });
    await tx.clubUserAccess.create({ data: { userId: users.manager, clubId: clubs[clubIndex], role: "manager" } });
  });
  await revokeCurrentSession("demo_role_switch");
  const store = await cookies();
  store.delete("club_ops_accounts");
  store.set("scope_company", visit.companyId, { httpOnly: true, sameSite: "lax", secure: !config.local, path: "/", expires: visit.expiresAt });
  if (role === "manager") store.set("scope_club", clubs[clubIndex], { httpOnly: true, sameSite: "lax", secure: !config.local, path: "/", expires: visit.expiresAt });
  else store.delete("scope_club");
  // Expiry is clamped inside createSession, so a demo token never outlives TTL.
  await createSession(users[role], visit.expiresAt);
  return role === "accountant" ? "/workspace" : "/dashboard?month=2026-11";
}
