import { create } from "zustand";

export type Theme = "dark" | "light";
const KEY = "recpm-theme";

const read = (): Theme => {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
};

export const useTheme = create<{ theme: Theme; toggle: () => void }>((set, get) => ({
  theme: read(),
  toggle: () => {
    const theme: Theme = get().theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(KEY, theme);
    } catch {}
    set({ theme });
  },
}));

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Aplica a cor do tenant (branding.primaryColor) nas variáveis CSS. Valor inválido = cor padrão. */
export function applyBrand(color: unknown) {
  const root = document.documentElement.style;
  if (typeof color === "string" && HEX_RE.test(color)) {
    root.setProperty("--brand", color);
    root.setProperty("--brand-foreground", contrastText(color));
  } else {
    root.removeProperty("--brand");
    root.removeProperty("--brand-foreground");
  }
}

/** Texto branco ou quase preto, o que der mais contraste (luminância relativa WCAG). */
function contrastText(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#111114";
}
