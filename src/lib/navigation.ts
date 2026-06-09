import type { AppPage } from "@/lib/auth";

export type NavItem = {
  page: AppPage;
  href: string;
  label: string;
};

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { page: "dashboard", href: "/dashboard", label: "Дашборд" },
  { page: "analytics", href: "/analytics", label: "Аналитика" },
  { page: "expenses", href: "/expenses", label: "Расходы" },
  { page: "invoices", href: "/invoices", label: "Счета" },
  { page: "payments", href: "/payments", label: "Календарь платежей" },
  { page: "refunds", href: "/refunds", label: "Возвраты" },
  { page: "budgets", href: "/budgets", label: "Бюджеты" },
  { page: "sales", href: "/sales", label: "Продажи" },
  { page: "imports", href: "/imports", label: "Импорт" },
  { page: "documents", href: "/documents", label: "Документы" },
  { page: "activity", href: "/activity", label: "История действий" },
  { page: "users", href: "/users", label: "Пользователи" },
  { page: "settings", href: "/settings", label: "Настройки" },
];

export const ROLE_LABELS: Record<string, string> = {
  owner: "Собственник",
  general_director: "Ген.директор",
  regional_director: "Региональный директор",
  manager: "Управляющий",
  accountant: "Бухгалтер",
  marketer: "Маркетолог",
};
