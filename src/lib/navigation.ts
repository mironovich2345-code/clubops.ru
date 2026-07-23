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
  { page: "ofd_sales", href: "/analytics/ofd-sales", label: "ОФД-продажи" },
  { page: "expenses", href: "/expenses", label: "Наличные расходы" },
  { page: "collections", href: "/collections", label: "Инкассация" },
  { page: "invoices", href: "/invoices", label: "Счета" },
  { page: "payments", href: "/payments", label: "Календарь платежей" },
  { page: "mandatory_payments", href: "/mandatory-payments", label: "Обязательные платежи" },
  { page: "balances", href: "/balances", label: "Остатки ДС" },
  { page: "employees", href: "/employees", label: "Сотрудники" },
  { page: "payroll", href: "/payroll", label: "Зарплата (ФОТ)" },
  { page: "refunds", href: "/refunds", label: "Возвраты" },
  { page: "budgets", href: "/budgets", label: "Бюджеты" },
  // "sales" (ручной сменный отчёт) удалён из меню — продажи поступают из ОФД. Route
  // /sales остаётся как read-only заглушка (ручной ввод отключён).
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
  { type: "item", page: "ofd_sales" },
  { type: "group", id: "finance", label: "Финансы", pages: ["expenses", "collections", "invoices", "refunds"] },
  // "mandatory_payments" and "balances" routes stay accessible (ROLE_PAGE_ACCESS)
  // but are no longer separate menu items — mandatory payments live inside the
  // payment calendar and balances are surfaced in dashboard cards.
  { type: "group", id: "planning", label: "Планирование", pages: ["payments", "budgets"] },
  { type: "item", page: "employees" },
  { type: "item", page: "payroll" },
  { type: "item", page: "documents" },
  { type: "group", id: "admin", label: "Администрирование", pages: ["users", "activity", "settings"] },
];

// Pages removed from the sidebar for strategic roles (owner / general director).
// The ROUTES stay accessible (e.g. opening a specific sales report from the
// dashboard "Неподтверждённые продажи" block) — only the menu entry is hidden.
export const STRATEGIC_HIDDEN_PAGES: ReadonlyArray<AppPage> = ["sales", "employees", "activity"];

export const ROLE_LABELS: Record<string, string> = {
  owner: "Собственник",
  general_director: "Ген.директор",
  regional_director: "Региональный директор",
  manager: "Управляющий",
  chief_accountant: "Главный бухгалтер",
  accountant: "Бухгалтер",
  marketer: "Маркетолог",
};
