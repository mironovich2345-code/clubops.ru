import type { CurrentUser } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/navigation";

export function UserBadge({ user }: { user: CurrentUser }) {
  const initials = user.name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
        {initials || "?"}
      </div>
      <div className="leading-tight">
        <div className="text-sm font-medium text-slate-900">{user.name}</div>
        <div className="text-xs text-slate-500">{ROLE_LABELS[user.role] ?? user.role}</div>
      </div>
    </div>
  );
}
