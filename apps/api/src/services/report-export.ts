/**
 * Exportação dos relatórios (§6.5): o mesmo documento (título + seções em tabela) vira CSV,
 * XLSX (uma aba por seção) ou PDF (A4 paisagem, cabeçalho repetido a cada página).
 */
import ExcelJS from "exceljs";
import { PDFDocument, type PDFFont, rgb, StandardFonts } from "pdf-lib";

export type ColumnKind = "text" | "int" | "num" | "money" | "date" | "datetime" | "pct";
export type ExportColumn = { key: string; label: string; kind?: ColumnKind; width?: number };
export type ExportCell = string | number | null | undefined;
export type ExportTable = { title: string; columns: ExportColumn[]; rows: Record<string, ExportCell>[] };
export type ExportDoc = { title: string; subtitle?: string; locale: string; sections: ExportTable[] };
export type ExportFormat = "csv" | "xlsx" | "pdf";

const tzDate = (iso: string, locale: string, withTime: boolean) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : "America/Sao_Paulo",
    dateStyle: "short",
    ...(withTime ? { timeStyle: "short" } : {}),
  }).format(d);
};

/** Texto da célula como aparece no PDF (no CSV/XLSX os números ficam números). */
function display(v: ExportCell, kind: ColumnKind | undefined, locale: string): string {
  if (v === null || v === undefined || v === "") return "";
  switch (kind) {
    case "money":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(Number(v) / 100);
    case "num":
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Number(v));
    case "int":
      return new Intl.NumberFormat(locale).format(Number(v));
    case "pct":
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Number(v))}%`;
    case "date":
      return tzDate(String(v), locale, false);
    case "datetime":
      return tzDate(String(v), locale, true);
    default:
      return String(v);
  }
}

const csvCell = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(doc: ExportDoc): Uint8Array {
  const lines: string[] = [];
  doc.sections.forEach((t, i) => {
    if (doc.sections.length > 1) {
      if (i) lines.push("");
      lines.push(csvCell(t.title));
    }
    lines.push(t.columns.map((c) => csvCell(c.label)).join(","));
    for (const r of t.rows)
      lines.push(
        t.columns
          .map((c) => {
            const v = r[c.key];
            if (v === null || v === undefined) return "";
            if (c.kind === "money") return String(Number(v) / 100);
            if (c.kind === "datetime" || c.kind === "date" || typeof v === "number") return String(v);
            return csvCell(String(v));
          })
          .join(","),
      );
  });
  // BOM: o Excel abre acentos certo
  return new TextEncoder().encode(`﻿${lines.join("\r\n")}\r\n`);
}

export async function toXlsx(doc: ExportDoc): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Rec PM";
  wb.title = doc.title;
  const used = new Set<string>();
  for (const t of doc.sections) {
    let name = t.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Dados";
    for (let n = 2; used.has(name); n++) name = `${name.slice(0, 28)} ${n}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.columns = t.columns.map((c) => ({
      header: c.label,
      key: c.key,
      width:
        c.width ??
        Math.min(
          48,
          Math.max(
            10,
            c.label.length + 4,
            ...t.rows.slice(0, 200).map((r) => String(r[c.key] ?? "").length + 2),
          ),
        ),
      style: {
        numFmt:
          c.kind === "money"
            ? '"R$" #,##0.00'
            : c.kind === "num"
              ? "0.0"
              : c.kind === "pct"
                ? '0.0"%"'
                : c.kind === "date"
                  ? "dd/mm/yyyy"
                  : c.kind === "datetime"
                    ? "dd/mm/yyyy hh:mm"
                    : undefined,
      },
    }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of t.rows)
      ws.addRow(
        Object.fromEntries(
          t.columns.map((c) => {
            const v = r[c.key];
            if (v === null || v === undefined || v === "") return [c.key, null];
            if (c.kind === "money") return [c.key, Number(v) / 100];
            if (c.kind === "date") return [c.key, new Date(`${String(v).slice(0, 10)}T00:00:00Z`)];
            if (c.kind === "datetime") return [c.key, new Date(String(v))];
            return [c.key, v];
          }),
        ),
      );
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Fontes padrão do PDF usam WinAnsi: troca o que não cabe. */
const winAnsi = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[•·]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "?");

const fitText = (s: string, font: PDFFont, size: number, w: number) => {
  if (font.widthOfTextAtSize(s, size) <= w) return s;
  let out = s;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`.replace("…", "..."), size) > w)
    out = out.slice(0, -1);
  return `${out}...`;
};

export async function toPdf(doc: ExportDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 841.89;
  const H = 595.28;
  const M = 36;
  const ink = rgb(0.1, 0.1, 0.14);
  const muted = rgb(0.4, 0.42, 0.48);
  const line = rgb(0.85, 0.86, 0.9);
  const accent = rgb(0.43, 0.36, 0.99);
  let page = pdf.addPage([W, H]);
  let y = H - M;
  let pageNo = 1;
  const footer = () =>
    page.drawText(winAnsi(`${doc.title} - Rec PM - ${pageNo}`), { x: M, y: 18, size: 7, font, color: muted });
  const newPage = () => {
    footer();
    page = pdf.addPage([W, H]);
    pageNo++;
    y = H - M;
  };
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: accent });
  page.drawText(winAnsi(doc.title), { x: M, y: y - 16, size: 16, font: bold, color: ink });
  y -= 24;
  if (doc.subtitle) {
    page.drawText(winAnsi(doc.subtitle), { x: M, y: y - 10, size: 9, font, color: muted });
    y -= 16;
  }
  y -= 8;
  const size = 8;
  const rowH = 14;
  for (const t of doc.sections) {
    const total = W - 2 * M;
    const weights = t.columns.map(
      (c) => c.width ?? (c.kind && c.kind !== "text" ? (c.kind === "datetime" ? 1.4 : 1) : 2.2),
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / sum) * total);
    const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const right = (k?: ColumnKind) => !!k && k !== "text" && k !== "date" && k !== "datetime";
    const header = () => {
      page.drawRectangle({ x: M, y: y - rowH + 3, width: total, height: rowH, color: rgb(0.95, 0.95, 0.97) });
      t.columns.forEach((c, i) => {
        const txt = fitText(winAnsi(c.label), bold, size, widths[i]! - 6);
        const tw = bold.widthOfTextAtSize(txt, size);
        page.drawText(txt, {
          x: right(c.kind) ? xs[i]! + widths[i]! - 3 - tw : xs[i]! + 3,
          y: y - 8,
          size,
          font: bold,
          color: ink,
        });
      });
      y -= rowH;
    };
    if (y < M + rowH * 4) newPage();
    page.drawText(winAnsi(t.title), { x: M, y: y - 11, size: 11, font: bold, color: ink });
    y -= 18;
    header();
    if (!t.rows.length) {
      page.drawText(
        winAnsi(doc.locale.startsWith("en") ? "No data in this period." : "Sem dados no período."),
        {
          x: M + 3,
          y: y - 8,
          size,
          font,
          color: muted,
        },
      );
      y -= rowH;
    }
    for (const r of t.rows) {
      if (y < M + rowH) {
        newPage();
        header();
      }
      t.columns.forEach((c, i) => {
        const txt = fitText(winAnsi(display(r[c.key], c.kind, doc.locale)), font, size, widths[i]! - 6);
        const tw = font.widthOfTextAtSize(txt, size);
        page.drawText(txt, {
          x: right(c.kind) ? xs[i]! + widths[i]! - 3 - tw : xs[i]! + 3,
          y: y - 8,
          size,
          font,
          color: ink,
        });
      });
      page.drawLine({
        start: { x: M, y: y - rowH + 3 },
        end: { x: W - M, y: y - rowH + 3 },
        thickness: 0.4,
        color: line,
      });
      y -= rowH;
    }
    y -= 14;
  }
  footer();
  pdf.setTitle(winAnsi(doc.title));
  pdf.setProducer("Rec PM");
  return pdf.save();
}

export async function renderExport(doc: ExportDoc, format: ExportFormat) {
  const slug = doc.title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (format === "csv") return { body: toCsv(doc), mime: "text/csv; charset=utf-8", filename: `${slug}.csv` };
  if (format === "xlsx")
    return {
      body: await toXlsx(doc),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: `${slug}.xlsx`,
    };
  return { body: await toPdf(doc), mime: "application/pdf", filename: `${slug}.pdf` };
}
