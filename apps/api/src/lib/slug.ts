/** "Arte digital" → "arte-digital" (ou "arte_digital" com sep "_"). */
export const slugify = (s: string, sep: "-" | "_" = "-") =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "")
    .slice(0, 46) || "item";

/** Primeiro slug livre: base, base-2, base-3… */
export const freeSlug = (base: string, taken: Iterable<string>, sep: "-" | "_" = "-") => {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${sep}${i}`)) return `${base}${sep}${i}`;
};
