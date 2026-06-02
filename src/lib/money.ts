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
