"use client";

import { useState } from "react";
import { Sheet } from "@/components/mobile/Sheet";
import { switchAccountAction, removeAccountAction, logoutAllAction, startAddAccountAction } from "../account-actions";
import { SwitchIcon } from "@/components/mobile/icons";
import type { AccountSummary } from "@/lib/account-container";

// Account switcher (spec §10/§11). Compact current-account block that opens an
// «Аккаунты» sheet: switch between independent device-local accounts, add another,
// remove one from the device, or sign out of all. Switching an account = switching
// the actual User — a full navigation happens server-side (revalidate + redirect).
export function AccountSwitcher({
  current,
  accounts,
}: {
  current: { name: string; roleLabel: string; companyName: string | null };
  accounts: AccountSummary[];
}) {
  const [open, setOpen] = useState(false);
  const initials = current.name.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
  const others = accounts.length > 1;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full min-w-0 items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">{initials}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-900">{current.name}</span>
          <span className="block truncate text-xs text-slate-500">
            {current.roleLabel}{current.companyName ? ` · ${current.companyName}` : ""}
          </span>
        </span>
        <SwitchIcon className="h-4 w-4 shrink-0 text-slate-400" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Аккаунты" variant="full">
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.storedId}>
              <div className={`flex items-center gap-3 rounded-lg border p-3 ${a.active ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white"}`}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700">
                  {(a.name.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("")) || "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{a.name}</div>
                  <div className="truncate text-xs text-slate-500">{a.email}</div>
                  <div className="mt-0.5">
                    {a.active ? (
                      <span className="text-xs font-medium text-brand-700">Активен</span>
                    ) : a.status === "needs_login" ? (
                      <span className="text-xs font-medium text-amber-700">Требуется вход</span>
                    ) : (
                      <span className="text-xs text-slate-400">Готов к переключению</span>
                    )}
                  </div>
                </div>
                {!a.active ? (
                  <form action={switchAccountAction}>
                    <input type="hidden" name="storedId" value={a.storedId} />
                    <button type="submit" className="inline-flex min-h-[44px] items-center rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700">
                      {a.status === "needs_login" ? "Войти" : "Переключиться"}
                    </button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 space-y-2 border-t border-slate-200 pt-4">
          <form action={startAddAccountAction}>
            <button type="submit" className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-brand-300 bg-white px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50">
              + Добавить аккаунт
            </button>
          </form>
          {others ? (
            <form action={removeAccountAction} onSubmit={(e) => { if (!confirm("Удалить текущий аккаунт с этого устройства?")) e.preventDefault(); }}>
              <input type="hidden" name="storedId" value={accounts.find((a) => a.active)?.storedId ?? ""} />
              <button type="submit" className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50">
                Удалить текущий аккаунт с устройства
              </button>
            </form>
          ) : null}
          <form action={logoutAllAction} onSubmit={(e) => { if (!confirm("Выйти из всех аккаунтов на этом устройстве?")) e.preventDefault(); }}>
            <button type="submit" className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-rose-300 bg-white px-4 text-sm font-medium text-rose-700 hover:bg-rose-50">
              Выйти из всех аккаунтов
            </button>
          </form>
        </div>
      </Sheet>
    </div>
  );
}
