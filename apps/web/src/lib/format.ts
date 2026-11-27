/** Formatação por locale: moeda a partir de centavos e datas em dd/MM/yyyy (pt-BR). */
export const money = (cents: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);

export const date = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(
    new Date(iso),
  );

/** Dias inteiros até a data (arredonda para cima; 0 = hoje ou já passou). */
export const daysUntil = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
