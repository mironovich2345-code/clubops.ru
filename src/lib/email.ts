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
