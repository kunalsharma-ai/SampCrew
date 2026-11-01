import { formatAmount, type BidPricing } from '@crew/contracts';
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';

export interface ProposalData {
  workspace: string;
  code: string;
  version: number;
  title: string;
  issuedOn: string;
  validUntil: string | null;
  client: { name: string; legalName: string | null; contactName: string | null; address: string | null };
  currency: string;
  startDate: string;
  durationMonths: number;
  coverNote: string;
  terms: string;
  preparedBy: string;
  pricing: BidPricing;
}

/** The standard PDF fonts only cover Windows-1252; map common typography and drop anything else. */
function clean(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/₹/g, 'INR ')
    .replace(/\t/g, '    ')
    .replace(/[^\x20-\x7e\xa0-\xff\n]/g, '?');
}

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.11, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.86, 0.87, 0.9);
const ACCENT = rgb(0.31, 0.27, 0.9);

/**
 * Renders the client-facing proposal. It shows roles, people, rates and totals, never costs or margins, which
 * stay internal to CREW.
 */
export async function renderProposal(d: ProposalData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(clean(`${d.code} ${d.title}`));
  pdf.setAuthor(clean(d.workspace));
  pdf.setSubject('Staffing proposal');
  pdf.setProducer('CREW by SAMPLEDGE');
  pdf.setCreationDate(new Date(`${d.issuedOn}T00:00:00Z`));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const width = A4[0] - 2 * M;
  const newPage = () => {
    page = pdf.addPage(A4);
    y = A4[1] - M;
  };
  const ensure = (h: number) => {
    if (y - h < M + 24) newPage();
  };
  const text = (s: string, x: number, size: number, font: PDFFont = regular, color = INK) => {
    page.drawText(clean(s), { x, y, size, font, color });
  };
  const right = (s: string, xRight: number, size: number, font: PDFFont = regular, color = INK) => {
    const t = clean(s);
    page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  };
  const wrap = (s: string, size: number, font: PDFFont, max: number): string[] => {
    const out: string[] = [];
    for (const para of clean(s).split('\n')) {
      if (!para.trim()) { out.push(''); continue; }
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > max && line) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  };
  const paragraph = (s: string, size = 10, font = regular, color = INK) => {
    for (const l of wrap(s, size, font, width)) {
      ensure(size + 4);
      if (l) text(l, M, size, font, color);
      y -= size + 4;
    }
  };
  const money = (v: string) => `${d.currency} ${formatAmount(v, d.currency)}`;

  // Header
  text(d.workspace, M, 16, bold);
  right('Staffing proposal', M + width, 11, bold, ACCENT);
  y -= 16;
  right(`${d.code} · version ${d.version}`.replace('·', '-'), M + width, 9, regular, MUTED);
  y -= 12;
  right(`Issued ${d.issuedOn}${d.validUntil ? `, valid until ${d.validUntil}` : ''}`, M + width, 9, regular, MUTED);
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 1, color: RULE });
  y -= 24;

  // Client and title
  text('Prepared for', M, 9, regular, MUTED);
  y -= 14;
  text(d.client.legalName || d.client.name, M, 12, bold);
  y -= 14;
  if (d.client.contactName) { text(`Attention: ${d.client.contactName}`, M, 10); y -= 13; }
  if (d.client.address) for (const l of wrap(d.client.address, 9, regular, width / 2)) { text(l, M, 9, regular, MUTED); y -= 12; }
  y -= 12;
  paragraph(d.title, 14, bold);
  y -= 4;
  paragraph(`${d.pricing.headcount} ${d.pricing.headcount === 1 ? 'person' : 'people'} for ${d.durationMonths} ${d.durationMonths === 1 ? 'month' : 'months'} from ${d.startDate}.`, 10, regular, MUTED);
  y -= 8;
  if (d.coverNote.trim()) { paragraph(d.coverNote); y -= 8; }

  // Roles table
  const cols = [M, M + 200, M + 300, M + 345, M + width];
  const header = () => {
    ensure(40);
    page.drawRectangle({ x: M, y: y - 6, width, height: 20, color: rgb(0.95, 0.95, 0.98) });
    text('Role', cols[0]! + 6, 9, bold, MUTED);
    text('Location', cols[1]!, 9, bold, MUTED);
    right('People', cols[3]! - 6, 9, bold, MUTED);
    right('Rate per person / month', cols[4]! - 130, 9, bold, MUTED);
    right('Per month', cols[4]! - 6, 9, bold, MUTED);
    y -= 24;
  };
  header();
  for (const l of d.pricing.lines) {
    const roleLines = wrap(l.roleTitle, 10, regular, 190);
    const h = roleLines.length * 13 + 6;
    if (y - h < M + 24) { newPage(); header(); }
    const top = y;
    roleLines.forEach((r, i) => { y = top - i * 13; text(r, cols[0]! + 6, 10); });
    y = top;
    text(l.location ?? '-', cols[1]!, 10, regular, MUTED);
    right(String(l.headcount), cols[3]! - 6, 10);
    right(money(l.billMonthly), cols[4]! - 130, 10);
    right(money(l.monthlyRevenue), cols[4]! - 6, 10);
    y = top - h;
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: M + width, y: y + 4 }, thickness: 0.5, color: RULE });
    y -= 6;
  }
  ensure(70);
  y -= 6;
  const total = (label: string, value: string, strong = false) => {
    right(label, cols[4]! - 130, 10, strong ? bold : regular, strong ? INK : MUTED);
    right(value, cols[4]! - 6, strong ? 11 : 10, strong ? bold : regular);
    y -= 16;
  };
  total('Monthly total', money(d.pricing.monthlyRevenue));
  total(`Term`, `${d.durationMonths} ${d.durationMonths === 1 ? 'month' : 'months'}`);
  total('Contract value', money(d.pricing.contractRevenue), true);
  y -= 4;
  paragraph('Amounts exclude applicable taxes.', 8, regular, MUTED);
  y -= 10;

  if (d.terms.trim()) {
    ensure(40);
    paragraph('Terms', 11, bold);
    y -= 2;
    paragraph(d.terms, 9);
  }

  // Footer on every page
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const f = clean(`Prepared by ${d.preparedBy}, ${d.workspace}`);
    p.drawText(f, { x: M, y: 28, size: 8, font: regular, color: MUTED });
    const n = `Page ${i + 1} of ${pages.length}`;
    p.drawText(n, { x: M + width - regular.widthOfTextAtSize(n, 8), y: 28, size: 8, font: regular, color: MUTED });
  });
  return Buffer.from(await pdf.save());
}
