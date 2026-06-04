import type { AppPage } from "@/lib/auth";

export type NavItem = {
  page: AppPage;
  href: string;
  label: string;
};

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { page: "dashboard", href: "/dashboard", label: "Дашборд" },
  { page: "expenses", href: "/expenses", label: "Расходы" },
  { page: "invoices", href: "/invoices", label: "Счета" },
  { page: "refunds", href: "/refunds", label: "Возвраты" },
  { page: "budgets", href: "/budgets", label: "Бюджеты" },
  { page: "sales", href: "/sales", label: "Продажи" },
  { page: "imports", href: "/imports", label: "Импорт" },
  { page: "documents", href: "/documents", label: "Документы" },
  { page: "users", href: "/users", label: "Пользователи" },
  { page: "settings", href: "/settings", label: "Настройки" },
];

export const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  regional_director: "Региональный директор",
  manager: "Менеджер",
  accountant: "Бухгалтер",
};
