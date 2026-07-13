// Server-only email service (Node runtime — never Edge). Wraps Mail.ru SMTP via
// nodemailer, with a fail-closed in-memory test transport for deterministic
// tests. Credentials come only from env; nothing is hard-coded. Configuration is
// validated at send time (not import/build time) so unrelated pages never crash
// during `next build` when SMTP env is absent.
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export type SendResult = { ok: true } | { ok: false; errorCode: string };

// --- Test transport (deterministic tests only) -----------------------------
// Captures the last message in memory. Enabled ONLY when explicitly flagged AND
// not in production — it fails closed in production so real mail is never
// silently dropped.
export type CapturedEmail = { to: string; subject: string; text: string; html?: string };
let lastTestEmail: CapturedEmail | null = null;

function testTransportEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.OTP_TEST_TRANSPORT === "1" || process.env.NODE_ENV === "test";
}

export function getLastTestEmail(): CapturedEmail | null {
  return lastTestEmail;
}

/**
 * Whether email delivery is available (test transport in dev/test, or a fully
 * configured SMTP transport). Actions that REQUIRE an OTP (password / email
 * change) gate on this and show a clear message when false — never a crash and
 * never a console.log fallback. Exposes no secret values.
 */
export function emailConfigured(): boolean {
  return testTransportEnabled() || readSmtpConfig() !== null;
}

/** Safe, value-free email configuration diagnostics (for /api/health). */
export function emailConfigStatus(): { provider: "configured" | "absent"; sender: "configured" | "absent" } {
  const cfg = readSmtpConfig();
  return {
    provider: cfg || testTransportEnabled() ? "configured" : "absent",
    sender: cfg?.from || testTransportEnabled() ? "configured" : "absent",
  };
}

// --- Real SMTP transport ---------------------------------------------------
let cachedTransport: Transporter | null = null;

type SmtpConfig = {
  host: string; port: number; secure: boolean; user: string; password: string; from: string;
};

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM || user;
  if (!host || !user || !password || !from) return null;
  const port = Number(process.env.SMTP_PORT ?? "465");
  // Default to implicit TLS (Mail.ru :465). Explicit override via SMTP_SECURE.
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465;
  return { host, port, secure, user, password, from };
}

function getTransport(cfg: SmtpConfig): Transporter {
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.password },
      // Bounded timeouts so an unresponsive SMTP server fails fast (sanitized
      // error + resend) instead of hanging the login request indefinitely.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
  }
  return cachedTransport;
}

// --- Sanitized delivery logging --------------------------------------------
function recipientDomain(to: string): string {
  const at = to.lastIndexOf("@");
  return at >= 0 ? to.slice(at + 1) : "unknown";
}

function logDeliveryError(requestId: string, to: string, errorCode: string): void {
  // Never log the OTP, full recipient, credentials or provider body.
  console.error(
    JSON.stringify({
      event: "otp.delivery_failed",
      requestId,
      recipientDomain: recipientDomain(to),
      errorCode,
      env: process.env.NODE_ENV ?? "development",
      at: new Date().toISOString(),
    }),
  );
}

// --- OTP email -------------------------------------------------------------
function buildOtpEmail(code: string, expiresMinutes: number): { subject: string; text: string; html: string } {
  const subject = "Код входа в CLUB-OPS";
  const text =
    `CLUB-OPS\n\n` +
    `Код для входа: ${code}\n` +
    `Код действует ${expiresMinutes} минут и запрошен для входа в систему.\n\n` +
    `Никому не сообщайте этот код. Если вы не запрашивали вход, проигнорируйте письмо.`;
  const html =
    `<div style="font-family:sans-serif;max-width:480px">` +
    `<h2 style="margin:0 0 8px">CLUB-OPS</h2>` +
    `<p>Код для входа в систему:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
    `<p>Код действует ${expiresMinutes} минут и запрошен для входа.</p>` +
    `<p style="color:#b91c1c">Никому не сообщайте этот код.</p>` +
    `<p style="color:#64748b;font-size:12px">Если вы не запрашивали вход, проигнорируйте это письмо.</p>` +
    `</div>`;
  return { subject, text, html };
}

/**
 * Send the login OTP. Returns a coarse SendResult — the caller maps failure to a
 * safe Russian message and records deliveryFailedAt. Provider responses and
 * credentials are never surfaced to the caller or the client.
 */
export async function sendOtpEmail(
  to: string,
  code: string,
  expiresMinutes: number,
  requestId: string,
): Promise<SendResult> {
  const { subject, text, html } = buildOtpEmail(code, expiresMinutes);

  if (testTransportEnabled()) {
    lastTestEmail = { to, subject, text, html };
    // Dev convenience ONLY (test transport is fail-closed in production): surface
    // the code locally so a developer can complete login without real SMTP.
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEV OTP] login code for ${to}: ${code}`);
    }
    return { ok: true };
  }

  const cfg = readSmtpConfig();
  if (!cfg) {
    logDeliveryError(requestId, to, "smtp_not_configured");
    return { ok: false, errorCode: "smtp_not_configured" };
  }

  try {
    await getTransport(cfg).sendMail({ from: cfg.from, to, subject, text, html });
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "smtp_send_failed";
    logDeliveryError(requestId, to, String(code));
    return { ok: false, errorCode: String(code) };
  }
}

// --- Account deletion / recovery emails (Part 16) --------------------------
// Generic sender reused by every template. Contains no financial/Company data,
// no IDs, no tokens beyond the APP_URL recovery link, and fails safely with a
// sanitized SendResult (never surfaces SMTP internals).
async function sendMail(to: string, subject: string, text: string, html: string, requestId: string): Promise<SendResult> {
  if (testTransportEnabled()) {
    lastTestEmail = { to, subject, text, html };
    if (process.env.NODE_ENV !== "production") console.log(`[DEV MAIL] "${subject}" -> ${to}`);
    return { ok: true };
  }
  const cfg = readSmtpConfig();
  if (!cfg) {
    logDeliveryError(requestId, to, "smtp_not_configured");
    return { ok: false, errorCode: "smtp_not_configured" };
  }
  try {
    await getTransport(cfg).sendMail({ from: cfg.from, to, subject, text, html });
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "smtp_send_failed";
    logDeliveryError(requestId, to, String(code));
    return { ok: false, errorCode: String(code) };
  }
}

function wrap(inner: string): string {
  return `<div style="font-family:sans-serif;max-width:480px"><h2 style="margin:0 0 8px">CLUB-OPS</h2>${inner}</div>`;
}
function codeBlock(code: string): string {
  return `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>`;
}

export type ActionEmailKind = "deletion" | "restore" | "change_password" | "change_email_current" | "change_email_new";

const ACTION_EMAIL_LABEL: Record<ActionEmailKind, { what: string; subject: string }> = {
  deletion: { what: "удаление аккаунта", subject: "Код подтверждения удаления аккаунта CLUB-OPS" },
  restore: { what: "восстановление аккаунта", subject: "Код восстановления аккаунта CLUB-OPS" },
  change_password: { what: "изменение пароля", subject: "Код подтверждения изменения пароля CLUB-OPS" },
  change_email_current: { what: "изменение email — подтверждение текущей почты", subject: "Код подтверждения изменения email CLUB-OPS" },
  change_email_new: { what: "изменение email — подтверждение новой почты", subject: "Код подтверждения новой почты CLUB-OPS" },
};

/** OTP for a sensitive account action (deletion / restore / password / email). */
export function sendActionOtpEmail(
  to: string, code: string, expiresMinutes: number, requestId: string,
  kind: ActionEmailKind,
): Promise<SendResult> {
  const { what, subject } = ACTION_EMAIL_LABEL[kind];
  const text =
    `CLUB-OPS\n\nКод для действия «${what}»: ${code}\n` +
    `Код действует ${expiresMinutes} минут.\n\nНикому не сообщайте этот код. Если вы не запрашивали это действие, проигнорируйте письмо.`;
  const html = wrap(`<p>Код для действия «${what}»:</p>${codeBlock(code)}<p>Код действует ${expiresMinutes} минут.</p><p style="color:#b91c1c">Никому не сообщайте этот код.</p><p style="color:#64748b;font-size:12px">Если вы не запрашивали это действие, проигнорируйте письмо.</p>`);
  return sendMail(to, subject, text, html, requestId);
}

/** Notice that the account was deleted and the email released. */
export function sendDeletionCompletedEmail(to: string, requestId: string, byOwner: boolean): Promise<SendResult> {
  const subject = "Аккаунт CLUB-OPS удалён";
  const who = byOwner ? "Ваш аккаунт был удалён администратором организации." : "Ваш аккаунт был удалён.";
  const body =
    `${who} Адрес электронной почты освобождён и может быть использован для новой регистрации. ` +
    `Финансовая история сохранена. Восстановление доступно в течение 30 дней по ссылке из отдельного письма. ` +
    `После восстановления прежние права доступа НЕ возвращаются автоматически.`;
  const text = `CLUB-OPS\n\n${body}\n\nЕсли это были не вы, срочно обратитесь к администратору системы.`;
  const html = wrap(`<p>${body}</p><p style="color:#64748b;font-size:12px">Если это были не вы, срочно обратитесь к администратору системы.</p>`);
  return sendMail(to, subject, text, html, requestId);
}

/** Recovery link (APP_URL-based) sent to the original email after deletion. */
export function sendRecoveryLinkEmail(to: string, restoreUrl: string, requestId: string): Promise<SendResult> {
  const subject = "Восстановление аккаунта CLUB-OPS";
  const text =
    `CLUB-OPS\n\nВы можете восстановить аккаунт в течение 30 дней по ссылке:\n${restoreUrl}\n\n` +
    `Ссылка одноразовая. Права доступа к компаниям и клубам после восстановления НЕ возвращаются автоматически. ` +
    `Никому не передавайте эту ссылку. Если вы не удаляли аккаунт, обратитесь к администратору системы.`;
  const html = wrap(`<p>Вы можете восстановить аккаунт в течение 30 дней:</p><p><a href="${restoreUrl}">Восстановить аккаунт</a></p><p>Ссылка одноразовая. Права доступа после восстановления НЕ возвращаются автоматически.</p><p style="color:#64748b;font-size:12px">Никому не передавайте эту ссылку. Если вы не удаляли аккаунт, обратитесь к администратору системы.</p>`);
  return sendMail(to, subject, text, html, requestId);
}

/** Confirmation that the account was restored. */
export function sendRestorationCompletedEmail(to: string, requestId: string): Promise<SendResult> {
  const subject = "Аккаунт CLUB-OPS восстановлен";
  const body = "Ваш аккаунт восстановлен. Войдите с паролем и кодом подтверждения из email. Права доступа к компаниям и клубам необходимо запросить у администратора заново.";
  const text = `CLUB-OPS\n\n${body}`;
  return sendMail(to, subject, text, wrap(`<p>${body}</p>`), requestId);
}

// --- Invitation emails (Block A) -------------------------------------------
// Carry NO tokens outside the URL, NO bank data, documents, internal ids or
// extra PII. The link is a full APP_URL-based accept-invite URL (built by the
// caller). Failures return a sanitized SendResult; the business operation
// (invite/access) is never rolled back on SMTP error.

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** Invitation to a not-yet-registered (or unverified) email — contains the link. */
export function sendInviteEmail(
  to: string,
  params: { inviterLabel: string; roleLabel: string; scopeLabel: string; expiresLabel: string; acceptUrl: string },
  requestId: string,
): Promise<SendResult> {
  const { inviterLabel, roleLabel, scopeLabel, expiresLabel, acceptUrl } = params;
  const subject = "Вас пригласили в CLUB-OPS";
  const text =
    `CLUB-OPS\n\n` +
    `${inviterLabel} предоставил(а) вам доступ.\n` +
    `Роль: ${roleLabel}\n` +
    `Доступ: ${scopeLabel}\n` +
    `Ссылка действует до: ${expiresLabel}\n\n` +
    `Чтобы получить доступ, перейдите по ссылке и войдите или зарегистрируйтесь с этим же адресом email:\n${acceptUrl}\n\n` +
    `Если вы не ожидали это приглашение, просто проигнорируйте письмо.`;
  const html = wrap(
    `<p>${esc(inviterLabel)} предоставил(а) вам доступ.</p>` +
      `<p><b>Роль:</b> ${esc(roleLabel)}<br/><b>Доступ:</b> ${esc(scopeLabel)}<br/><b>Ссылка действует до:</b> ${esc(expiresLabel)}</p>` +
      `<p><a href="${esc(acceptUrl)}">Принять приглашение</a></p>` +
      `<p>Войдите или зарегистрируйтесь с этим же адресом email.</p>` +
      `<p style="color:#64748b;font-size:12px">Если вы не ожидали это приглашение, проигнорируйте письмо.</p>`,
  );
  return sendMail(to, subject, text, html, requestId);
}

/** Notice to an existing verified user who was granted access directly (no link). */
export function sendAccessGrantedEmail(
  to: string,
  params: { companyName: string; roleLabel: string; scopeLabel: string; loginUrl: string | null },
  requestId: string,
): Promise<SendResult> {
  const { companyName, roleLabel, scopeLabel, loginUrl } = params;
  const subject = "Вам предоставлен доступ к CLUB-OPS";
  const linkLine = loginUrl ? `\n\nВойти: ${loginUrl}` : "";
  const text =
    `CLUB-OPS\n\n` +
    `Вам предоставлен доступ в компании «${companyName}».\n` +
    `Роль: ${roleLabel}\n` +
    `Доступ: ${scopeLabel}${linkLine}\n\n` +
    `Доступ уже активен — войдите под своим адресом email.`;
  const html = wrap(
    `<p>Вам предоставлен доступ в компании «${esc(companyName)}».</p>` +
      `<p><b>Роль:</b> ${esc(roleLabel)}<br/><b>Доступ:</b> ${esc(scopeLabel)}</p>` +
      (loginUrl ? `<p><a href="${esc(loginUrl)}">Войти в CLUB-OPS</a></p>` : "") +
      `<p>Доступ уже активен — войдите под своим адресом email.</p>`,
  );
  return sendMail(to, subject, text, html, requestId);
}

