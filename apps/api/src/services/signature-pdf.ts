/**
 * PDF final da assinatura eletrônica: o documento original + uma página de certificado com
 * o código de verificação, o SHA-256 do original e a trilha de cada signatário.
 * Feito com pdf-lib (puro JS), sem depender de serviço externo.
 */
import { createHash, randomBytes } from "node:crypto";
import { PDFDocument, type PDFFont, rgb, StandardFonts } from "pdf-lib";

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Código público de verificação: 12 caracteres sem ambiguidade, em grupos de 4. */
export function newVerificationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export const newSignerToken = () => randomBytes(32).toString("base64url");

export type CertificateInfo = {
  title: string;
  workspace: string;
  requestId: string;
  verificationCode: string;
  verifyUrl: string;
  documentSha256: string;
  completedAt: Date;
  signers: {
    name: string;
    email: string;
    signedAt: Date;
    ip: string | null;
    userAgent: string | null;
  }[];
};

/** As fontes padrão do PDF usam WinAnsi: troca o que não cabe nela. */
const winAnsi = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  // palavras enormes (hash): quebra por caractere
  return out.flatMap((l) => {
    if (font.widthOfTextAtSize(l, size) <= width) return [l];
    const parts: string[] = [];
    let cur = "";
    for (const ch of l) {
      if (font.widthOfTextAtSize(cur + ch, size) > width) {
        parts.push(cur);
        cur = ch;
      } else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  });
}

const fmt = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "America/Sao_Paulo",
  }).format(d);

export async function buildSignedPdf(original: Uint8Array, info: CertificateInfo): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(original, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const W = 595.28;
  const H = 841.89;
  const M = 50;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.1, 0.1, 0.14);
  const muted = rgb(0.38, 0.4, 0.46);
  const accent = rgb(0.43, 0.36, 0.99);

  const ensure = (h: number) => {
    if (y - h < M) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };
  const text = (t: string, o: { size?: number; f?: PDFFont; color?: typeof ink; gap?: number } = {}) => {
    const size = o.size ?? 10;
    const f = o.f ?? font;
    for (const line of wrap(winAnsi(t), f, size, W - 2 * M)) {
      ensure(size + 4);
      page.drawText(line, { x: M, y: y - size, size, font: f, color: o.color ?? ink });
      y -= size + 4;
    }
    y -= o.gap ?? 4;
  };
  const rule = () => {
    ensure(12);
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.6, color: muted });
    y -= 14;
  };

  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: accent });
  text("Certificado de assinatura eletrônica", { size: 18, f: bold, gap: 2 });
  text(`${info.workspace} · Rec PM`, { color: muted, gap: 14 });
  text("Documento", { size: 9, f: bold, color: muted, gap: 0 });
  text(info.title, { size: 12, f: bold, gap: 10 });
  text("Código de verificação", { size: 9, f: bold, color: muted, gap: 0 });
  text(info.verificationCode, { size: 14, f: mono, gap: 2 });
  text(`Confira a autenticidade em ${info.verifyUrl}`, { size: 9, color: muted, gap: 10 });
  text("SHA-256 do documento original", { size: 9, f: bold, color: muted, gap: 0 });
  text(info.documentSha256, { size: 9, f: mono, gap: 10 });
  text(`Concluído em ${fmt(info.completedAt)} (horário de Brasília) · ID ${info.requestId}`, {
    size: 9,
    color: muted,
    gap: 6,
  });
  rule();
  text(`Signatários (${info.signers.length})`, { size: 12, f: bold, gap: 8 });
  for (const sg of info.signers) {
    ensure(70);
    text(sg.name, { size: 11, f: bold, gap: 0 });
    text(sg.email, { size: 9, color: muted, gap: 0 });
    text(`Assinou em ${fmt(sg.signedAt)}${sg.ip ? ` · IP ${sg.ip}` : ""}`, { size: 9, gap: 0 });
    if (sg.userAgent) text(`Navegador: ${sg.userAgent.slice(0, 160)}`, { size: 8, color: muted, gap: 0 });
    y -= 8;
  }
  rule();
  text(
    "Cada signatário recebeu um link pessoal por e-mail, visualizou o documento e confirmou a assinatura digitando o próprio nome. " +
      "Qualquer alteração no documento muda o SHA-256 acima. A página de verificação mostra o hash deste arquivo final.",
    { size: 8, color: muted },
  );
  pdf.setTitle(`${winAnsi(info.title)} (assinado)`);
  pdf.setProducer("Rec PM");
  return pdf.save();
}
