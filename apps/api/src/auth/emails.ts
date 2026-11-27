import type { Mail } from "../lib/mailer";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const layout = (title: string, body: string, cta: { label: string; url: string }) => `<!doctype html>
<html lang="pt-BR"><body style="font-family:system-ui,sans-serif;background:#f6f7f9;padding:32px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:32px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
<p style="font-size:15px;line-height:1.5;color:#333">${body}</p>
<p><a href="${esc(cta.url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${esc(cta.label)}</a></p>
<p style="font-size:12px;color:#777">Se você não esperava este e-mail, pode ignorá-lo.</p>
</div></body></html>`;

export const resetPasswordEmail = (to: string, name: string, url: string): Mail => ({
  to,
  subject: "Redefinir sua senha do Rec PM",
  html: layout(
    "Redefinir senha",
    `Olá, ${esc(name)}. Recebemos um pedido para redefinir sua senha. O link vale por 1 hora.`,
    { label: "Criar nova senha", url },
  ),
  text: `Olá, ${name}. Para redefinir sua senha do Rec PM, acesse: ${url} (válido por 1 hora).`,
});

export const verifyEmailEmail = (to: string, name: string, url: string): Mail => ({
  to,
  subject: "Confirme seu e-mail no Rec PM",
  html: layout("Confirme seu e-mail", `Olá, ${esc(name)}. Confirme seu e-mail para ativar a conta.`, {
    label: "Confirmar e-mail",
    url,
  }),
  text: `Olá, ${name}. Confirme seu e-mail no Rec PM: ${url}`,
});

export const invitationEmail = (to: string, inviter: string, workspace: string, url: string): Mail => ({
  to,
  subject: `${inviter} convidou você para ${workspace} no Rec PM`,
  html: layout(
    `Convite para ${workspace}`,
    `${esc(inviter)} convidou você para participar de <b>${esc(workspace)}</b> no Rec PM.`,
    { label: "Aceitar convite", url },
  ),
  text: `${inviter} convidou você para ${workspace} no Rec PM. Aceite em: ${url}`,
});

export const usageWarningEmail = (
  to: string,
  name: string,
  workspace: string,
  percent: 80 | 90 | 100,
  used: number,
  limit: number,
  url: string,
): Mail => {
  const reached = percent === 100;
  const subject = reached
    ? `${workspace}: limite de tarefas do plano atingido`
    : `${workspace}: ${percent}% das tarefas do plano usadas`;
  const body = reached
    ? `Olá, ${name}. O workspace ${workspace} usou as ${limit} tarefas do ciclo. Novas tarefas ficam bloqueadas até a virada do ciclo ou um upgrade de plano.`
    : `Olá, ${name}. O workspace ${workspace} já criou ${used} de ${limit} tarefas neste ciclo (${percent}%).`;
  return {
    to,
    subject,
    html: layout(subject, `<p>${esc(body)}</p>`, { label: "Ver plano e uso", url }),
    text: `${body} Plano e uso: ${url}`,
  };
};
