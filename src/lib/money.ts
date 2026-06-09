const rubFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function rublesToKopeks(rubles: number): number {
  return Math.round(rubles * 100);
}

export function formatKopeks(kopeks: number): string {
  return rubFormatter.format(kopeks / 100);
}

/**
 * Compact rubles label for dense chart bars: "1.2м", "120к", "850", "0".
 * Drops kopecks and the ₽ sign to save space (tooltips use the full format).
 */
export function formatKopeksShort(kopeks: number): string {
  const rub = kopeks / 100;
  const sign = rub < 0 ? "−" : "";
  const a = Math.abs(rub);
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}м`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)}к`;
  return `${sign}${Math.round(a)}`;
}
