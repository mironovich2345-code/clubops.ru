"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { resendInvite, regenerateInviteLink, revokeInvite } from "../actions";

type ActionState = { ok: boolean; error?: string; notice?: string; linkUrl?: string; emailWarning?: boolean };
const initial: ActionState = { ok: false };

function ActionButton({ label, pendingLabel, tone = "neutral" }: { label: string; pendingLabel: string; tone?: "neutral" | "danger" }) {
  const { pending } = useFormStatus();
  const base =
    tone === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60 ${base}`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

/** Resend / regenerate-link / revoke controls for one pending invite. Shown only
 * when the invite is still actionable (pending / expired / email_failed). */
export function InviteRowActions({ inviteId, canResend }: { inviteId: string; canResend: boolean }) {
  const [resendState, resendAction] = useFormState(resendInvite, initial);
  const [linkState, linkAction] = useFormState(regenerateInviteLink, initial);
  const [revokeState, revokeAction] = useFormState(revokeInvite, initial);
  const [copied, setCopied] = useState(false);

  const notice = resendState.notice || linkState.notice || revokeState.notice;
  const error = resendState.error || linkState.error || revokeState.error;
  const warn = resendState.emailWarning;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {canResend ? (
          <form action={resendAction}>
            <input type="hidden" name="inviteId" value={inviteId} />
            <ActionButton label="Отправить повторно" pendingLabel="Отправка..." />
          </form>
        ) : null}
        {canResend ? (
          <form action={linkAction}>
            <input type="hidden" name="inviteId" value={inviteId} />
            <ActionButton label="Скопировать новую ссылку" pendingLabel="..." />
          </form>
        ) : null}
        <form action={revokeAction}>
          <input type="hidden" name="inviteId" value={inviteId} />
          <ActionButton label="Отозвать" pendingLabel="..." tone="danger" />
        </form>
      </div>

      {linkState.ok && linkState.linkUrl ? (
        <div className="rounded-md bg-emerald-50 p-2 ring-1 ring-inset ring-emerald-200">
          <div className="text-xs font-medium text-emerald-800">
            Новая ссылка (показывается один раз). Предыдущая больше не действует:
          </div>
          <div className="mt-1 flex gap-2">
            <input
              readOnly
              value={linkState.linkUrl}
              className="w-full rounded-md border border-emerald-200 bg-white px-2 py-1 text-[11px] text-slate-700"
            />
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(linkState.linkUrl!);
                setCopied(true);
              }}
              className="whitespace-nowrap rounded-md border border-emerald-300 bg-white px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
            >
              {copied ? "Скопировано" : "Копировать"}
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <span className={`text-xs ${warn ? "text-amber-700" : "text-emerald-700"}`}>{notice}</span>
      ) : null}
      {error ? <span className="text-xs text-rose-600">{error}</span> : null}
    </div>
  );
}
