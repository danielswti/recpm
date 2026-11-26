/**
 * Envio de e-mail. Produção: Resend. Desenvolvimento: SMTP do Mailpit (docker-compose).
 * Testes: `memoryMailer()` guarda as mensagens para asserção.
 * Templates React Email entram com o pacote packages/emails; por ora, HTML simples em pt-BR.
 */
import nodemailer from "nodemailer";
import { Resend } from "resend";

export type Mail = { to: string; subject: string; html: string; text: string };
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export const createMailer = (opts: {
  resendApiKey?: string;
  smtpUrl?: string;
  from: string;
  production: boolean;
}): Mailer => {
  if (opts.resendApiKey) {
    const resend = new Resend(opts.resendApiKey);
    return {
      async send(m) {
        const { error } = await resend.emails.send({ from: opts.from, ...m });
        if (error) throw new Error(`Resend: ${error.message}`);
      },
    };
  }
  if (opts.smtpUrl) {
    const t = nodemailer.createTransport(opts.smtpUrl);
    return { send: async (m) => void (await t.sendMail({ from: opts.from, ...m })) };
  }
  if (opts.production) throw new Error("E-mail sem transporte: defina RESEND_API_KEY ou SMTP_URL");
  // Dev sem Mailpit: imprime o texto (com os links) no console.
  return { send: async (m) => console.info(`[mailer] para ${m.to}: ${m.subject}\n${m.text}`) };
};

export const memoryMailer = () => {
  const outbox: Mail[] = [];
  const mailer: Mailer & { outbox: Mail[] } = { outbox, send: async (m) => void outbox.push(m) };
  return mailer;
};
