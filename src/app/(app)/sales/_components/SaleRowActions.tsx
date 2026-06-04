"use client";

import { transitionSale } from "../actions";

const ACTION_LABELS: Record<string, string> = {
  confirm: "Подтвердить",
  reject: "Отклонить",
  cancel: "Отменить",
};

const ACTION_CLASS: Record<string, string> = {
  confirm: "border-emerald-300 bg-emerald-600 text-white hover:bg-emerald-700",
  reject: "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100",
  cancel: "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100",
};

const CONFIRM_TEXT: Record<string, string> = {
  confirm: "Подтвердить продажу как выручку?",
  cancel: "Отменить продажу? Действие нельзя отменить.",
};

export function SaleRowActions({ saleId, actions }: { saleId: string; actions: string[] }) {
  if (actions.length === 0) return <span className="text-xs text-slate-400">—</span>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((action) => (
        <form
          key={action}
          action={transitionSale}
          onSubmit={(e) => {
            if (action === "reject") {
              const reason = window.prompt("Причина отклонения (необязательно):", "");
              if (reason === null) {
                e.preventDefault();
                return;
              }
              const input = e.currentTarget.querySelector(
                'input[name="rejectionReason"]',
              ) as HTMLInputElement | null;
              if (input) input.value = reason;
            } else if (CONFIRM_TEXT[action] && !window.confirm(CONFIRM_TEXT[action])) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="saleId" value={saleId} />
          <input type="hidden" name="action" value={action} />
          {action === "reject" ? <input type="hidden" name="rejectionReason" value="" /> : null}
          <button
            type="submit"
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              ACTION_CLASS[action] ?? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {ACTION_LABELS[action] ?? action}
          </button>
        </form>
      ))}
    </div>
  );
}
