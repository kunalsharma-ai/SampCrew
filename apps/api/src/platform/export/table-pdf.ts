import 'regenerator-runtime/runtime';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFPage, rgb } from 'pdf-lib';
import { Fonts, type Weight } from '../../modules/bids/proposal-pdf';
import type { Cell } from './tabular';

const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const M = 36;
const INK = rgb(0.11, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.86, 0.87, 0.9);
const HEAD = rgb(0.95, 0.95, 0.97);

/**
 * A report as a PDF table on landscape A4: a title, a subtitle line (workspace, filters, date), then the rows with
 * the header repeated on every page and page numbers. Column widths follow the content; long cells are cut with an
 * ellipsis (the Excel download has the full text). Text in any script Noto Sans covers prints correctly.
 */
export async function renderTablePdf(title: string, subtitle: string, rows: Cell[][]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setProducer('SampCrew by SAMPLEDGE');
  const fonts = new Fonts(pdf);
  const regular: Weight = 400;
  const bold: Weight = 700;
  const texts = rows.flat().map((c) => (c === null || c === undefined ? '' : String(c)));
  await fonts.prepare([title, subtitle, 'Page of … 0123456789', ...texts], [regular, bold]);

  const [W, H] = A4_LANDSCAPE;
  const width = W - 2 * M;
  const [header = [], ...body] = rows;
  const cols = Math.max(1, header.length);
  // Wide reports (a column per day or per leave type) get a smaller type so their values fit.
  const size = cols > 16 ? 6.5 : cols > 11 ? 7 : 8;
  // Natural widths from the values and the longest word of each heading (headings wrap), capped, then scaled.
  const longestWord = (h: unknown) => Math.max(0, ...String(h ?? '').split(/\s+/).map((w) => fonts.width(w, size, bold)));
  const natural = Array.from({ length: cols }, (_, i) => Math.min(180, Math.max(26, longestWord(header[i]) + 10, ...body.slice(0, 200).map((r) => fonts.width(String(r[i] ?? ''), size, regular) + 10))));
  const scale = width / natural.reduce((a, b) => a + b, 0);
  const widths = natural.map((w) => w * scale);
  const fit = (s: string, w: number, weight: Weight) => {
    if (fonts.width(s, size, weight) <= w - 6) return s;
    let t = s;
    while (t.length > 1 && fonts.width(`${t}…`, size, weight) > w - 6) t = t.slice(0, -1);
    return `${t}…`;
  };

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const rowH = size * 2;
  // Headings wrap onto up to three lines instead of being cut short.
  const wrap = (s: string, w: number): string[] => {
    const lines: string[] = [];
    for (const word of s.split(/\s+/).filter(Boolean)) {
      const last = lines.at(-1);
      if (last !== undefined && fonts.width(`${last} ${word}`, size, bold) <= w - 6) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    if (lines.length > 3) return [...lines.slice(0, 2), fit(lines.slice(2).join(' '), w, bold)];
    return lines.length ? lines.map((l) => fit(l, w, bold)) : [''];
  };
  const headLines = header.map((h, i) => wrap(String(h ?? ''), widths[i]!));
  const headH = Math.max(1, ...headLines.map((l) => l.length)) * (size + 2) + 6;
  const drawHeader = () => {
    page.drawRectangle({ x: M, y: y - headH + 4, width, height: headH, color: HEAD });
    let x = M;
    headLines.forEach((lines, i) => {
      lines.forEach((l, j) => fonts.draw(page, l, x + 3, y - 8 - j * (size + 2), size, bold, INK));
      x += widths[i]!;
    });
    y -= headH;
  };
  const newPage = (first: boolean) => {
    page = pdf.addPage(A4_LANDSCAPE);
    pages.push(page);
    y = H - M;
    if (first) {
      fonts.draw(page, title, M, y - 14, 16, bold, INK);
      fonts.draw(page, subtitle, M, y - 30, 9, regular, MUTED);
      y -= 46;
    }
    drawHeader();
  };
  newPage(true);
  if (!body.length) fonts.draw(page, 'No rows.', M + 3, y - 10, size, regular, MUTED);
  for (const r of body) {
    if (y - rowH < M + 18) newPage(false);
    let x = M;
    r.forEach((c, i) => {
      if (i >= cols) return;
      fonts.draw(page, fit(c === null || c === undefined ? '' : String(c), widths[i]!, regular), x + 3, y - size, size, regular, INK);
      x += widths[i]!;
    });
    page.drawLine({ start: { x: M, y: y - rowH + 4 }, end: { x: M + width, y: y - rowH + 4 }, thickness: 0.4, color: RULE });
    y -= rowH;
  }
  pages.forEach((p, i) => fonts.draw(p, `Page ${i + 1} of ${pages.length}`, W - M - 60, M - 14, 8, regular, MUTED));
  return Buffer.from(await pdf.save());
}
