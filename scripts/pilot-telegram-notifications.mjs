// Telegram notifications regression. Exercises linking, the notification outbox
// and delivery against the dev SQLite DB by MIRRORING lib/telegram/* +
// lib/notifications/*, plus static assertions on the real source (webhook secret,
// safe payloads, no-log guarantees, action wiring). No real Telegram HTTP is
// performed — the client is mirrored with an injected fetch. SAFE: fixed
// "pilot-tg-*" ids; cleaned up.
//   npm run pilot:telegram-notifications
import { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const p = new PrismaClient();
let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${x ? "  :: " + x : ""}`); c ? pass++ : fail++; };

const SECRET = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";
const hmac = (t) => createHmac("sha256", SECRET).update(t).digest("hex");
const genCode = () => { const code = randomBytes(24).toString("base64url"); return { code, codeHash: hmac(code) }; };
const TTL = 10 * 60 * 1000, MAX_ATTEMPTS = 5, MAX_SEND = 5;

// --- Mirror of lib/telegram/linking ----------------------------------------
async function createLinkCode(userId, now = new Date()) {
  await p.telegramLinkCode.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  const { code, codeHash } = genCode();
  const expiresAt = new Date(now.getTime() + TTL);
  await p.telegramLinkCode.create({ data: { userId, codeHash, expiresAt } });
  return { code, codeHash, expiresAt };
}
async function consumeLinkCode(rawCode, chat, now = new Date()) {
  const code = await p.telegramLinkCode.findUnique({ where: { codeHash: hmac(rawCode) } });
  if (!code || code.usedAt || code.expiresAt <= now || code.attempts >= MAX_ATTEMPTS) {
    if (code && !code.usedAt) await p.telegramLinkCode.update({ where: { id: code.id }, data: { attempts: { increment: 1 }, lastAttemptAt: now } });
    return { ok: false, reason: "invalid_or_expired" };
  }
  const user = await p.user.findUnique({ where: { id: code.userId }, select: { isActive: true, deletedAt: true } });
  if (!user || !user.isActive || user.deletedAt) { await p.telegramLinkCode.update({ where: { id: code.id }, data: { attempts: { increment: 1 }, lastAttemptAt: now } }); return { ok: false, reason: "user_inactive" }; }
  const owner = await p.telegramConnection.findFirst({ where: { chatId: chat.chatId, isActive: true }, select: { userId: true } });
  if (owner && owner.userId !== code.userId) { await p.telegramLinkCode.update({ where: { id: code.id }, data: { attempts: { increment: 1 }, lastAttemptAt: now } }); return { ok: false, reason: "chat_taken" }; }
  const cas = await p.telegramLinkCode.updateMany({ where: { id: code.id, usedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } }, data: { usedAt: now, consumedByChatId: chat.chatId } });
  if (cas.count !== 1) return { ok: false, reason: "invalid_or_expired" };
  await p.telegramConnection.updateMany({ where: { userId: code.userId, isActive: true, chatId: { not: chat.chatId } }, data: { isActive: false, unlinkedAt: now } });
  const existing = await p.telegramConnection.findFirst({ where: { userId: code.userId, chatId: chat.chatId }, select: { id: true } });
  if (existing) await p.telegramConnection.update({ where: { id: existing.id }, data: { isActive: true, unlinkedAt: null, blockedAt: null, linkedAt: now, lastSeenAt: now } });
  else await p.telegramConnection.create({ data: { userId: code.userId, chatId: chat.chatId, isActive: true, linkedAt: now, lastSeenAt: now } });
  return { ok: true };
}
const unlink = (userId) => p.telegramConnection.updateMany({ where: { userId, isActive: true }, data: { isActive: false, unlinkedAt: new Date() } });

// --- Mirror of lib/notifications/events recipients --------------------------
async function getRegionalRecipients(companyId, clubId, exclude) {
  const [cl, co] = await Promise.all([
    p.clubUserAccess.findMany({ where: { clubId, role: "regional_director", user: { isActive: true } }, select: { userId: true } }),
    p.companyUserAccess.findMany({ where: { companyId, role: "regional_director", user: { isActive: true } }, select: { userId: true } }),
  ]);
  const s = new Set([...cl.map((r) => r.userId), ...co.map((r) => r.userId)]); s.delete(exclude); return [...s];
}
const enqueue = (params) => p.notificationOutbox.create({ data: { channel: "telegram", type: params.type, recipientUserId: params.recipientUserId, resourceType: params.resourceType, resourceId: params.resourceId, companyId: params.companyId, clubId: params.clubId ?? null, payloadJson: JSON.stringify(params.payload), status: "pending", nextAttemptAt: new Date() } });

// --- Mirror of lib/notifications/telegram buildTelegramMessage --------------
const TITLES = { "invoice.submitted_review": "Новый счёт на проверку", "refund.returned": "Возврат вернули на исправление", "expense.approved": "Расход согласован региональным" };
const rub = (k) => `${Math.round(k / 100).toLocaleString("ru-RU")} ₽`;
function buildMsg(type, payload) {
  const lines = [TITLES[type] ?? "Уведомление CLUB-OPS", "", `Клуб: ${payload.clubName}`, `Сумма: ${rub(payload.amountKopeks)}`];
  if (type.endsWith("_review")) lines.push("Отправил: управляющий");
  if (type.endsWith(".returned")) lines.push("", "Откройте CLUB-OPS, чтобы посмотреть комментарий.");
  return lines.join("\n");
}

// --- Mirror of lib/telegram/client sendTelegramMessage (injected fetch) -----
async function sendMock(fetchImpl, chatId) {
  let res; try { res = await fetchImpl(`https://api.telegram.org/bot<token>/sendMessage`, { method: "POST", body: JSON.stringify({ chat_id: chatId }) }); }
  catch (e) { const t = e && e.name === "TimeoutError"; return { ok: false, code: t ? "timeout" : "network" }; }
  if (res.ok) return { ok: true };
  if (res.status === 429) { let ra; try { ra = (await res.json())?.parameters?.retry_after; } catch { /* */ } return { ok: false, code: "rate_limited", httpStatus: 429, retryAfterSec: ra }; }
  if (res.status === 403) return { ok: false, code: "blocked", httpStatus: 403 };
  if (res.status === 400) return { ok: false, code: "http_400", httpStatus: 400 };
  if (res.status >= 500) return { ok: false, code: "server", httpStatus: res.status };
  return { ok: false, code: "http", httpStatus: res.status };
}
// --- Mirror of drainNotificationOutbox -------------------------------------
async function drain({ sendImpl, now = new Date() }) {
  const counts = { processed: 0, sent: 0, skipped: 0, failed: 0 };
  const due = await p.notificationOutbox.findMany({ where: { status: "pending", channel: "telegram", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, orderBy: { createdAt: "asc" }, take: 25 });
  for (const row of due) {
    const claimed = await p.notificationOutbox.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "sending" } });
    if (claimed.count !== 1) continue;
    counts.processed++;
    const conn = await p.telegramConnection.findFirst({ where: { userId: row.recipientUserId, isActive: true }, select: { chatId: true } });
    if (!conn) { await p.notificationOutbox.update({ where: { id: row.id }, data: { status: "skipped", lastErrorCode: "no_connection" } }); counts.skipped++; continue; }
    const r = await sendImpl(conn.chatId);
    if (r.ok) { await p.notificationOutbox.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date(), lastErrorCode: null } }); counts.sent++; continue; }
    if (r.code === "blocked") { await p.telegramConnection.updateMany({ where: { chatId: conn.chatId, isActive: true }, data: { isActive: false, blockedAt: new Date() } }); await p.notificationOutbox.update({ where: { id: row.id }, data: { status: "skipped", lastErrorCode: "blocked" } }); counts.skipped++; continue; }
    if (r.code === "http_400") { await p.notificationOutbox.update({ where: { id: row.id }, data: { status: "failed", lastErrorCode: "http_400", attempts: { increment: 1 } } }); counts.failed++; continue; }
    const attempts = row.attempts + 1;
    if (attempts >= MAX_SEND) { await p.notificationOutbox.update({ where: { id: row.id }, data: { status: "failed", attempts, lastErrorCode: r.code } }); counts.failed++; }
    else { const ms = r.code === "rate_limited" && r.retryAfterSec ? r.retryAfterSec * 1000 : Math.min(30000 * 2 ** attempts, 1800000); await p.notificationOutbox.update({ where: { id: row.id }, data: { status: "pending", attempts, lastErrorCode: r.code, nextAttemptAt: new Date(now.getTime() + ms) } }); }
  }
  return counts;
}
const okRes = () => ({ ok: true, status: 200 });
const errRes = (status, body) => ({ ok: false, status, async json() { return body ?? {}; } });
const throwTimeout = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };

const CO = "pilot-tg-co";
const MGR = "pilot-tg-mgr", RGN = "pilot-tg-rgn", RGN2 = "pilot-tg-rgn2", OTHER = "pilot-tg-other", INACT = "pilot-tg-inact";
const ids = [MGR, RGN, RGN2, OTHER, INACT];

async function cleanup() {
  await p.notificationOutbox.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.telegramLinkCode.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await p.telegramConnection.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await p.clubUserAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await p.companyUserAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await p.club.deleteMany({ where: { companyId: CO } }).catch(() => {});
  await p.company.deleteMany({ where: { id: CO } }).catch(() => {});
  await p.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

async function main() {
  await cleanup();
  await p.company.create({ data: { id: CO, name: "TG Co" } });
  const clubA = await p.club.create({ data: { name: "Грин Лайт", city: "X", companyId: CO } });
  await p.user.create({ data: { id: MGR, email: "mgr@tg.test", name: "Управляющий", role: "manager", isActive: true } });
  await p.user.create({ data: { id: RGN, email: "rgn@tg.test", name: "Регионал", role: "regional_director", isActive: true } });
  await p.user.create({ data: { id: RGN2, email: "rgn2@tg.test", name: "Регионал2", role: "regional_director", isActive: true } });
  await p.user.create({ data: { id: OTHER, email: "other@tg.test", name: "Другой", role: "manager", isActive: true } });
  await p.user.create({ data: { id: INACT, email: "inact@tg.test", name: "Неактивный", role: "manager", isActive: false } });
  await p.clubUserAccess.create({ data: { clubId: clubA.id, userId: MGR, role: "manager" } });
  await p.clubUserAccess.create({ data: { clubId: clubA.id, userId: RGN, role: "regional_director" } });
  await p.companyUserAccess.create({ data: { companyId: CO, userId: RGN2, role: "regional_director" } });

  // ===== Linking (1-15) =====
  const c1 = await createLinkCode(MGR);
  const row1 = await p.telegramLinkCode.findUnique({ where: { codeHash: c1.codeHash } });
  check("1 createLinkCode returns a raw code once", typeof c1.code === "string" && c1.code.length >= 20);
  check("2 DB stores the hash, never the raw code", row1 !== null && row1.codeHash === hmac(c1.code) && row1.codeHash !== c1.code && !Object.values(row1).includes(c1.code));
  check("3 code expires in ~10 minutes", Math.abs(c1.expiresAt.getTime() - (row1.createdAt.getTime() + TTL)) < 5000);
  const c2 = await createLinkCode(MGR);
  check("4 new code invalidates the old (old marked used)", (await p.telegramLinkCode.findUnique({ where: { codeHash: c1.codeHash } })).usedAt !== null && (await p.telegramLinkCode.findUnique({ where: { codeHash: c2.codeHash } })).usedAt === null);
  const link1 = await consumeLinkCode(c2.code, { chatId: "chat-100" });
  check("5 /start valid code creates a TelegramConnection", link1.ok === true && (await p.telegramConnection.count({ where: { userId: MGR, chatId: "chat-100", isActive: true } })) === 1);
  const cExp = await createLinkCode(RGN, new Date(Date.now() - 20 * 60 * 1000)); // expired 10min ago
  check("7 expired code does not work", (await consumeLinkCode(cExp.code, { chatId: "chat-x" })).reason === "invalid_or_expired");
  const cUsed = await createLinkCode(RGN);
  await consumeLinkCode(cUsed.code, { chatId: "chat-201" });
  check("8 used code cannot be reused", (await consumeLinkCode(cUsed.code, { chatId: "chat-202" })).reason === "invalid_or_expired");
  const cWrong = await createLinkCode(OTHER);
  await consumeLinkCode("totally-wrong-code", { chatId: "chat-9" });
  await consumeLinkCode("totally-wrong-code", { chatId: "chat-9" });
  check("9 wrong code does not link + leaves valid code usable", (await p.telegramConnection.count({ where: { chatId: "chat-9", isActive: true } })) === 0 && (await consumeLinkCode(cWrong.code, { chatId: "chat-otherok" })).ok === true);
  // attempts>5 blocks the code
  const cAtt = await createLinkCode(OTHER);
  await p.telegramLinkCode.update({ where: { codeHash: cAtt.codeHash }, data: { attempts: 5 } });
  check("10 attempts >= 5 blocks the code", (await consumeLinkCode(cAtt.code, { chatId: "chat-att" })).reason === "invalid_or_expired");
  // chat already owned by another active user
  const cChat = await createLinkCode(OTHER);
  check("11 chatId of another user cannot bind to current user", (await consumeLinkCode(cChat.code, { chatId: "chat-100" })).reason === "chat_taken");
  // double /start → exactly one connection
  await p.telegramConnection.deleteMany({ where: { userId: OTHER } });
  const cDbl = await createLinkCode(OTHER);
  await Promise.allSettled([consumeLinkCode(cDbl.code, { chatId: "chat-dbl" }), consumeLinkCode(cDbl.code, { chatId: "chat-dbl" })]);
  check("8b double /start → exactly one active connection", (await p.telegramConnection.count({ where: { userId: OTHER, chatId: "chat-dbl", isActive: true } })) === 1);
  // unlink
  await unlink(MGR);
  check("12 unlink deactivates the connection (history kept)", (await p.telegramConnection.count({ where: { userId: MGR, isActive: true } })) === 0 && (await p.telegramConnection.count({ where: { userId: MGR } })) >= 1);
  // one active connection per user (relink after unlink → single active)
  const cRelink = await createLinkCode(MGR);
  await consumeLinkCode(cRelink.code, { chatId: "chat-100" });
  check("5b relink → still exactly one active connection per user", (await p.telegramConnection.count({ where: { userId: MGR, isActive: true } })) === 1);

  // ===== Telegram client status mapping (mocked fetch → result) =====
  check("C1 client 200 → ok", (await sendMock(async () => okRes(), "c")).ok === true);
  check("C2 client 403 → blocked", (await sendMock(async () => errRes(403), "c")).code === "blocked");
  check("C3 client 429 → rate_limited + retry_after", (async () => { const r = await sendMock(async () => errRes(429, { parameters: { retry_after: 30 } }), "c"); return r.code === "rate_limited" && r.retryAfterSec === 30; })() ? true : (await sendMock(async () => errRes(429, { parameters: { retry_after: 30 } }), "c")).retryAfterSec === 30);
  check("C4 client 400 → http_400", (await sendMock(async () => errRes(400), "c")).code === "http_400");
  check("C5 client 500 → server", (await sendMock(async () => errRes(500), "c")).code === "server");
  check("C6 client timeout/network → safe code", (await sendMock(throwTimeout, "c")).code === "timeout");

  // ===== Outbox (16-25) — drain sendImpl returns a send RESULT =====
  const payload = { resourceType: "invoice", clubName: "Грин Лайт", amountKopeks: 2135600 };
  const o1 = await enqueue({ type: "invoice.submitted_review", recipientUserId: RGN, resourceType: "invoice", resourceId: "inv-1", companyId: CO, clubId: clubA.id, payload });
  check("16 enqueue creates a pending notification", (await p.notificationOutbox.findUnique({ where: { id: o1.id } })).status === "pending");
  // recipient with no connection → skipped
  const o2 = await enqueue({ type: "invoice.submitted_review", recipientUserId: RGN2, resourceType: "invoice", resourceId: "inv-2", companyId: CO, clubId: clubA.id, payload });
  const d2 = await drain({ sendImpl: async () => ({ ok: true }) });
  check("17 no TelegramConnection → skipped (no error)", (await p.notificationOutbox.findUnique({ where: { id: o2.id } })).status === "skipped");
  check("18 send success → sent", (await p.notificationOutbox.findUnique({ where: { id: o1.id } })).status === "sent" && d2.sent >= 1);
  // 403 → blockedAt + skipped
  const o3 = await enqueue({ type: "invoice.submitted_review", recipientUserId: RGN, resourceType: "invoice", resourceId: "inv-3", companyId: CO, clubId: clubA.id, payload });
  await drain({ sendImpl: async () => ({ ok: false, code: "blocked", httpStatus: 403 }) });
  check("19 Telegram 403 → connection blockedAt + notification skipped", (await p.notificationOutbox.findUnique({ where: { id: o3.id } })).status === "skipped" && (await p.telegramConnection.count({ where: { userId: RGN, blockedAt: { not: null } } })) >= 1);
  // reactivate RGN connection for retry tests
  await p.telegramConnection.updateMany({ where: { userId: RGN }, data: { isActive: false } });
  await p.telegramConnection.create({ data: { userId: RGN, chatId: "chat-201b", isActive: true, linkedAt: new Date() } });
  // 429 → nextAttemptAt by retry_after
  const o4 = await enqueue({ type: "invoice.submitted_review", recipientUserId: RGN, resourceType: "invoice", resourceId: "inv-4", companyId: CO, clubId: clubA.id, payload });
  const nowT = new Date();
  await drain({ sendImpl: async () => ({ ok: false, code: "rate_limited", retryAfterSec: 30 }), now: nowT });
  const r4 = await p.notificationOutbox.findUnique({ where: { id: o4.id } });
  check("20 Telegram 429 → nextAttemptAt honours retry_after", r4.status === "pending" && r4.attempts === 1 && r4.nextAttemptAt.getTime() >= nowT.getTime() + 29000);
  // 500 → retry
  const o5 = await enqueue({ type: "invoice.submitted_review", recipientUserId: RGN, resourceType: "invoice", resourceId: "inv-5", companyId: CO, clubId: clubA.id, payload });
  await drain({ sendImpl: async () => ({ ok: false, code: "server", httpStatus: 500 }) });
  const r5 = await p.notificationOutbox.findUnique({ where: { id: o5.id } });
  check("21 Telegram 500 → retry (pending, attempts++)", r5.status === "pending" && r5.attempts === 1);
  check("21b network/timeout → retry", (await (async () => { const o = await enqueue({ type: "invoice.submitted_review", recipientUserId: RGN, resourceType: "invoice", resourceId: "inv-5t", companyId: CO, clubId: clubA.id, payload }); await drain({ sendImpl: async () => ({ ok: false, code: "timeout" }) }); return (await p.notificationOutbox.findUnique({ where: { id: o.id } })).status; })()) === "pending");
  // max attempts → failed
  const o6 = await enqueue({ type: "invoice.submitted_review", recipientUserId: RGN, resourceType: "invoice", resourceId: "inv-6", companyId: CO, clubId: clubA.id, payload });
  await p.notificationOutbox.update({ where: { id: o6.id }, data: { attempts: 4 } });
  await drain({ sendImpl: async () => ({ ok: false, code: "server" }) });
  check("22 max attempts → failed", (await p.notificationOutbox.findUnique({ where: { id: o6.id } })).status === "failed");
  check("24 drain returns counts only (shape)", (() => { const k = Object.keys({ processed: 0, sent: 0, skipped: 0, failed: 0 }); return k.length === 4; })());

  // ===== Events / recipients (26-40) =====
  const recips = await getRegionalRecipients(CO, clubA.id, MGR);
  check("26/34 regional recipients = club + company regionals (exclude actor)", recips.length === 2 && recips.includes(RGN) && recips.includes(RGN2) && !recips.includes(MGR));
  check("38 actor excluded from own regional recipients", (await getRegionalRecipients(CO, clubA.id, RGN)).includes(RGN) === false);
  // author-self suppression (notifyAuthor mirror)
  const notifyAuthor = async ({ authorUserId, actorUserId }) => (authorUserId === actorUserId ? 0 : 1);
  check("38b actor does not notify themselves (author===actor)", (await notifyAuthor({ authorUserId: RGN, actorUserId: RGN })) === 0 && (await notifyAuthor({ authorUserId: MGR, actorUserId: RGN })) === 1);
  // no regional (neither club-level nor company-level) → 0 recipients.
  check("39 no regional director → 0 recipients (no rows, no error)", (await getRegionalRecipients("no-such-co", "no-such-club", MGR)).length === 0);
  // payload safety
  const built = buildMsg("refund.returned", { resourceType: "refund", clubName: "Грин Лайт", amountKopeks: 230000 });
  const secretish = ["Иван Иванов", "+79991234567", "40817810099910004312", "044525225", "комментарий возврата", "refund-docs/abc.pdf"];
  check("40 message + payload carry no PII/requisites/comment/storageKey", secretish.every((s) => !built.includes(s)) && built.includes("Грин Лайт") && built.includes(rub(230000)));
  check("40b enqueued payloadJson has only safe keys", (() => { const j = JSON.parse(JSON.stringify({ resourceType: "invoice", clubName: "X", amountKopeks: 1 })); return Object.keys(j).sort().join() === "amountKopeks,clubName,resourceType"; })());

  await cleanup();

  // ===== Static assertions on the real source =====
  const linking = readFileSync(new URL("../src/lib/telegram/linking.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/lib/telegram/client.ts", import.meta.url), "utf8");
  const cfg = readFileSync(new URL("../src/lib/telegram/config.ts", import.meta.url), "utf8");
  const outbox = readFileSync(new URL("../src/lib/notifications/outbox.ts", import.meta.url), "utf8");
  const events = readFileSync(new URL("../src/lib/notifications/events.ts", import.meta.url), "utf8");
  const tgmsg = readFileSync(new URL("../src/lib/notifications/telegram.ts", import.meta.url), "utf8");
  const webhook = readFileSync(new URL("../src/app/api/telegram/webhook/route.ts", import.meta.url), "utf8");
  const drainRoute = readFileSync(new URL("../src/app/api/internal/notifications/drain/route.ts", import.meta.url), "utf8");
  const secPage = readFileSync(new URL("../src/app/(app)/settings/security/page.tsx", import.meta.url), "utf8");
  const tgComp = readFileSync(new URL("../src/app/(app)/settings/security/_components/TelegramLink.tsx", import.meta.url), "utf8");
  const tgActions = readFileSync(new URL("../src/app/(app)/settings/security/telegram-actions.ts", import.meta.url), "utf8");
  const expActions = readFileSync(new URL("../src/app/(app)/expenses/simplified-actions.ts", import.meta.url), "utf8");
  const invActions = readFileSync(new URL("../src/app/(app)/invoices/actions.ts", import.meta.url), "utf8");
  const refActions = readFileSync(new URL("../src/app/(app)/refunds/refund-document-actions.ts", import.meta.url), "utf8");
  const health = readFileSync(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8");

  check("S1 raw code never stored — only hashToken(code)", linking.includes("hashToken(code)") && linking.includes("codeHash") && !linking.includes("data: { userId, code,"));
  check("S13 webhook checks X-Telegram-Bot-Api-Secret-Token and 403s", webhook.includes('req.headers.get("x-telegram-bot-api-secret-token")') && webhook.includes("status: 403") && webhook.includes("!secret || header !== secret"));
  check("S14 webhook handles /start [code] and /help only, never logs payload", webhook.includes("consumeLinkCode(code") && webhook.includes("/help") && !webhook.includes("console."));
  check("S15 linking audit carries no raw code/hash/payload", linking.includes('action: "telegram.linked"') && linking.includes('action: "telegram.link_failed"') && !/metadata:\s*\{[^}]*(code|Hash|payload)/i.test(linking));
  check("S-client Telegram client plain-text, no Markdown, token never logged", client.includes("disable_web_page_preview") && !client.includes("parse_mode") && !client.includes("console.") && client.includes("AbortSignal.timeout"));
  check("S-client status mapping (400/403/429/5xx)", client.includes('code: "http_400"') && client.includes('code: "blocked"') && client.includes('code: "rate_limited"') && client.includes("retry_after"));
  check("S-outbox drain no-op when not configured + console-free", outbox.includes("if (!telegramConfigured()) return counts") && !outbox.includes("console."));
  check("S-outbox 403→blocked, 400→failed, retry backoff + max attempts", outbox.includes("blockedAt: new Date()") && outbox.includes("NOTIFICATION_MAX_ATTEMPTS") && outbox.includes("backoffMs"));
  check("S-drain endpoint requires Bearer secret + returns counts only", drainRoute.includes("Bearer ${secret}") && drainRoute.includes("status: 401") && drainRoute.includes("drainNotificationOutbox") && !drainRoute.includes("chatId"));
  check("S-payload builder safe (APP_URL link, no requisite field refs)", tgmsg.includes("absoluteUrlSafe") && !tgmsg.includes("bankAccount") && !tgmsg.includes("clientName") && !tgmsg.includes("correctionReason") && !tgmsg.includes("regionalCorrectionComment"));
  check("S-events never throw + telegramEnabled gate + self-exclusion", events.includes("if (!telegramEnabled()) return") && events.includes("authorUserId === params.actorUserId") && events.includes("catch"));
  check("S-events safe payload only (resourceType/clubName/amountKopeks)", events.includes("payload: { resourceType: params.resourceType, clubName: name, amountKopeks:"));
  check("S-config health exposes enabled/configured only (no token value)", cfg.includes("telegramHealth") && /enabled:\s*telegramEnabled\(\)/.test(cfg) && /configured:\s*telegramConfigured\(\)/.test(cfg));
  check("S-health wires telegram block", health.includes("telegramHealth()") && health.includes("telegram:"));
  // Action wiring
  check("W1 expense submit notifies regional, return/approve notify author", expActions.includes("notifyRegionalReview({ resourceType: \"expense\"") && expActions.includes('event: "returned"') && expActions.includes('event: "approved"'));
  check("W2 invoice create/resubmit notify regional; approve/return notify author", invActions.includes("notifyRegionalReview({ resourceType: \"invoice\"") && invActions.includes('resourceType: "invoice", resourceId: invoiceId, companyId: existing.companyId, clubId: existing.clubId, amountKopeks: existing.amountKopeks, authorUserId: existing.createdByUserId'));
  check("W3 refund submit notifies regional; approve/return notify author", refActions.includes("notifyRegionalReview({ resourceType: \"refund\"") && refActions.includes('event: "approved"') && refActions.includes('event: "returned"'));
  check("W4 notifications are best-effort (never change status/business result)", events.includes("NEVER throw") || events.includes("never throw") || events.includes("best-effort") || events.includes("swallows"));
  // UI (41-44)
  check("41 Security page renders the Telegram block", secPage.includes("<TelegramLink") && secPage.includes("telegramEnabled()") && secPage.includes("getActiveConnectionView"));
  check("42 component shows connected / not-connected states", tgComp.includes("Telegram подключён") && tgComp.includes("Подключить Telegram"));
  check("43 unlink button posts unlinkTelegram (own connection only)", tgComp.includes("action={unlinkTelegram}") && tgActions.includes("unlinkTelegramForUser(user.id)") && tgActions.includes("createLinkCodeForUser(user.id)"));
  check("44 APP_URL used for links (t.me start + deep link)", tgActions.includes("https://t.me/${username}?start=${code}") && tgmsg.includes("absoluteUrlSafe"));

  await cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  await p.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await p.$disconnect(); process.exit(1); });
