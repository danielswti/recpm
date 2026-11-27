// Tema antes da primeira pintura (escuro por padrão). Arquivo externo para a CSP não precisar de 'unsafe-inline'.
try {
  if (localStorage.getItem("recpm-theme") === "light") document.documentElement.classList.remove("dark");
} catch {}
