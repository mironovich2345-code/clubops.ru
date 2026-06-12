import type { AppPage } from "@/lib/auth";

export type NavItem = {
  page: AppPage;
  href: string;
  label: string;
};

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { page: "workspace", href: "/workspace", label: "Рабочий стол" },
  { page: "dashboard", href: "/dashboard", label: "Дашборд" },
  { page: "analytics", href: "/analytics", label: "Аналитика" },
  { page: "expenses", href: "/expenses", label: "Наличные расходы" },
  { page: "invoices", href: "/invoices", label: "Счета" },
  { page: "payments", href: "/payments", label: "Календарь платежей" },
  { page: "mandatory_payments", href: "/mandatory-payments", label: "Обязательные платежи" },
  { page: "balances", href: "/balances", label: "Остатки ДС" },
  { page: "refunds", href: "/refunds", label: "Возвраты" },
  { page: "budgets", href: "/budgets", label: "Бюджеты" },
  { page: "sales", href: "/sales", label: "Продажи" },
  { page: "imports", href: "/imports", label: "Импорт" },
  { page: "documents", href: "/documents", label: "Документы" },
  { page: "activity", href: "/activity", label: "История действий" },
  { page: "users", href: "/users", label: "Пользователи" },
  { page: "settings", href: "/settings", label: "Настройки" },
];

// Presentation-only grouping of the sidebar. References pages by key, so it never
// changes routes or access rules — the Sidebar resolves each page to its
// access-filtered NavItem (a group/page that the user cannot access is hidden).
// `imports` and `documents` are not part of the requested groups, so they remain
// standalone top-level items rather than being dropped from navigation.
export type NavSection =
  | { type: "item"; page: AppPage }
  | { type: "group"; id: string; label: string; pages: AppPage[] };

export const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  { type: "item", page: "workspace" },
  { type: "item", page: "dashboard" },
  { type: "item", page: "analytics" },
  { type: "item", page: "sales" },
  { type: "group", id: "finance", label: "Финансы", pages: ["expenses", "invoices", "refunds"] },
  { type: "group", id: "planning", label: "Планирование", pages: ["payments", "mandatory_payments", "balances", "budgets"] },
  { type: "item", page: "imports" },
  { type: "item", page: "documents" },
  { type: "group", id: "admin", label: "Администрирование", pages: ["users", "activity", "settings"] },
];

export const ROLE_LABELS: Record<string, string> = {
  owner: "Собственник",
  general_director: "Ген.директор",
  regional_director: "Региональный директор",
  manager: "Управляющий",
  accountant: "Бухгалтер",
  marketer: "Маркетолог",
};
