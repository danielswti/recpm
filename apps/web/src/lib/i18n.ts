import i18n from "i18next";
import { initReactI18next } from "react-i18next";
// Só o português vai no pacote inicial; as outras línguas chegam sob demanda (§9.10: JS inicial < 250 KB).
import ptBR from "../locales/pt-BR.json";

export const LOCALES = [
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "en", label: "English" },
] as const;

const KEY = "recpm-locale";
const stored = (() => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
})();

const LAZY: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import("../locales/en.json"),
};

async function ensureLanguage(lng: string) {
  if (i18n.hasResourceBundle(lng, "translation") || !LAZY[lng]) return;
  const { default: bundle } = await LAZY[lng]();
  i18n.addResourceBundle(lng, "translation", bundle, true, true);
}

const initial = stored ?? (navigator.language.toLowerCase().startsWith("pt") ? "pt-BR" : "en");
void i18n.use(initReactI18next).init({
  resources: { "pt-BR": { translation: ptBR } },
  lng: "pt-BR",
  fallbackLng: "pt-BR",
  interpolation: { escapeValue: false },
});
/** Resolve quando a língua inicial está pronta (o main.tsx espera por ela antes de desenhar). */
export const i18nReady: Promise<unknown> =
  initial === "pt-BR"
    ? Promise.resolve()
    : ensureLanguage(initial)
        .then(() => i18n.changeLanguage(initial))
        .catch(() => {});

/** Troca a língua carregando o arquivo dela se preciso. */
export async function setLanguage(lng: string) {
  await ensureLanguage(lng);
  await i18n.changeLanguage(lng);
}

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(KEY, lng);
  } catch {}
});

export default i18n;
