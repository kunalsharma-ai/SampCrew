import 'regenerator-runtime/runtime';
import { formatAmount, GST_STATES } from '@crew/contracts';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { Fonts, type Weight } from '../bids/proposal-pdf';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.11, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.86, 0.87, 0.9);
const ACCENT = rgb(0.31, 0.27, 0.9);

const address = (p: Row | null | undefined) => [p?.addressLine1, p?.addressLine2, [p?.city, p?.postalCode].filter(Boolean).join(' '), p?.stateCode ? `${GST_STATES[p.stateCode] ?? ''} (${p.stateCode})` : null, p?.countryCode].filter(Boolean).join(', ');

/**
 * A tax invoice (GST invoice when SAMPLEDGE has a GSTIN): seller and buyer with GSTINs, place of supply, SAC code,
 * lines, CGST/SGST or IGST, total and payment status. The numbers come from the stored invoice, never recomputed.
 */
export async function renderInvoice(inv: Row, lines: Row[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Invoice ${inv.number}`);
  pdf.setAuthor(inv.seller?.legalName ?? 'SAMPLEDGE');
  pdf.setProducer('SampCrew by SAMPLEDGE');
  pdf.setCreationDate(inv.issued_at ? new Date(inv.issued_at) : new Date());
  const fonts = new Fonts(pdf);
  const regular: Weight = 400;
  const bold: Weight = 700;
  const seller = inv.seller ?? {};
  const buyer = inv.buyer ?? {};
  const gst = Boolean(seller.gstin);
  const cur = inv.currency as string;
  const money = (v: string) => `${cur} ${formatAmount(String(v), cur)}`;
  const issued = inv.issued_at ? new Date(inv.issued_at).toISOString().slice(0, 10) : '';
  const due = inv.due_at ? new Date(inv.due_at).toISOString().slice(0, 10) : '';
  const status = inv.status === 'paid' ? `Paid${inv.paid_at ? ` on ${new Date(inv.paid_at).toISOString().slice(0, 10)}` : ''}${inv.paid_reference ? ` (ref. ${inv.paid_reference})` : ''}` : inv.status === 'void' ? 'Void' : `Due by ${due}`;
  await fonts.prepare([
    seller.legalName ?? '', buyer.legalName ?? '', address(seller), address(buyer), inv.number, inv.note ?? '', inv.place_of_supply ?? '', status,
    'Tax invoice Invoice Bill to From GSTIN PAN Place of supply SAC Description Qty Amount Subtotal Total Issued Period Status Page of to , . : ( ) - 0123456789 %',
    ...lines.flatMap((l) => [l.description, money(l.amount)]),
    ...(inv.tax_lines ?? []).flatMap((t: Row) => [`${t.label} ${t.rate}%`, money(t.amount)]),
    money(inv.subtotal), money(inv.total), seller.email ?? '', buyer.email ?? '',
  ], [regular, bold]);

  const page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const width = A4[0] - 2 * M;
  const text = (s: string, x: number, size: number, w: Weight = regular, color = INK) => fonts.draw(page, s, x, y, size, w, color);
  const right = (s: string, xr: number, size: number, w: Weight = regular, color = INK) => fonts.draw(page, s, xr - fonts.width(s, size, w), y, size, w, color);
  const wrap = (s: string, size: number, w: Weight, max: number) => {
    const out: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (fonts.width(next, size, w) > max && line) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
  };

  text(seller.legalName ?? 'SAMPLEDGE', M, 15, bold);
  right(gst ? 'Tax invoice' : 'Invoice', M + width, 13, bold, ACCENT);
  y -= 15;
  for (const l of wrap(address(seller), 8.5, regular, width * 0.55)) { text(l, M, 8.5, regular, MUTED); y -= 11; }
  if (seller.gstin) { text(`GSTIN ${seller.gstin}${seller.pan ? `   PAN ${seller.pan}` : ''}`, M, 8.5, regular, MUTED); y -= 11; }
  if (seller.email) { text(seller.email, M, 8.5, regular, MUTED); y -= 11; }
  const top = A4[1] - M - 18;
  const meta: [string, string][] = [['Invoice', inv.number], ['Issued', issued], ['Period', `${inv.period_start} to ${inv.period_end}`], ['Status', status]];
  meta.forEach(([k, v], i) => {
    const yy = top - i * 13;
    fonts.draw(page, k, M + width - 210, yy, 8.5, regular, MUTED);
    fonts.draw(page, v, M + width - fonts.width(v, 8.5, bold), yy, 8.5, bold, INK);
  });
  y = Math.min(y, top - meta.length * 13) - 14;
  page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 1, color: RULE });
  y -= 20;

  text('Bill to', M, 8.5, regular, MUTED);
  if (inv.place_of_supply) right(`Place of supply: ${inv.place_of_supply}`, M + width, 8.5, regular, MUTED);
  y -= 14;
  text(buyer.legalName ?? '', M, 11, bold);
  y -= 13;
  for (const l of wrap(address(buyer), 9, regular, width * 0.6)) { text(l, M, 9, regular, MUTED); y -= 12; }
  if (buyer.gstin) { text(`GSTIN ${buyer.gstin}`, M, 9); y -= 12; }
  if (buyer.email) { text(buyer.email, M, 9, regular, MUTED); y -= 12; }
  y -= 14;

  const colQty = M + width - 130;
  const colAmt = M + width - 6;
  page.drawRectangle({ x: M, y: y - 6, width, height: 20, color: rgb(0.95, 0.95, 0.98) });
  text('Description', M + 6, 8.5, bold, MUTED);
  if (seller.sac) text('SAC', M + width - 220, 8.5, bold, MUTED);
  right('Qty', colQty, 8.5, bold, MUTED);
  right('Amount', colAmt, 8.5, bold, MUTED);
  y -= 22;
  for (const l of lines) {
    const desc = wrap(String(l.description), 9.5, regular, width - 250);
    const rowTop = y;
    desc.forEach((d, i) => { y = rowTop - i * 12; text(d, M + 6, 9.5); });
    y = rowTop;
    if (seller.sac) text(String(seller.sac), M + width - 220, 9.5, regular, MUTED);
    right(String(Number(l.quantity)), colQty, 9.5);
    right(money(l.amount), colAmt, 9.5);
    y = rowTop - desc.length * 12 - 6;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: M + width, y: y + 2 }, thickness: 0.5, color: RULE });
    y -= 10;
  }
  y -= 4;
  const sumRow = (label: string, value: string, w: Weight = regular, size = 9.5) => {
    fonts.draw(page, label, colQty - 120, y, size, w, w === bold ? INK : MUTED);
    right(value, colAmt, size, w);
    y -= size + 6;
  };
  sumRow('Subtotal', money(inv.subtotal));
  for (const t of inv.tax_lines ?? []) sumRow(`${t.label} ${t.rate}%`, money(t.amount));
  y -= 2;
  page.drawLine({ start: { x: colQty - 120, y: y + 10 }, end: { x: M + width, y: y + 10 }, thickness: 1, color: RULE });
  sumRow('Total', money(inv.total), bold, 11);
  y -= 10;
  if (inv.note) for (const l of wrap(String(inv.note), 8.5, regular, width)) { text(l, M, 8.5, regular, MUTED); y -= 11; }
  if (inv.void_reason) { text(`Voided: ${inv.void_reason}`, M, 8.5, regular, MUTED); y -= 11; }
  y = M;
  text('SampCrew by SAMPLEDGE. This invoice was generated electronically and needs no signature.', M, 7.5, regular, MUTED);
  return Buffer.from(await pdf.save());
}
