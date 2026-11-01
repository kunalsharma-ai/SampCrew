import { readFileSync } from 'node:fs';
// fontkit's Indic shaper (Devanagari conjuncts) is compiled to regenerator code and expects this global.
import 'regenerator-runtime/runtime';
import { formatAmount, type BidPricing } from '@crew/contracts';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';

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

/**
 * Noto Sans, split by script (OFL, from @fontsource/noto-sans). Text is drawn with the first face that has each
 * character, so names and addresses in Latin, Greek, Cyrillic, Vietnamese and Devanagari print correctly
 * (Devanagari conjuncts are shaped by fontkit). Faces are embedded in a document only when it uses them.
 */
const SUBSETS = ['latin', 'latin-ext', 'devanagari', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese'] as const;
type Weight = 400 | 700;
type Kit = { hasGlyphForCodePoint(cp: number): boolean };
const fontFiles = new Map<string, { bytes: Buffer; kit: Kit }>();
function face(subset: string, weight: Weight) {
  const key = `${subset}-${weight}`;
  let f = fontFiles.get(key);
  if (!f) {
    const bytes = readFileSync(require.resolve(`@fontsource/noto-sans/files/noto-sans-${subset}-${weight}-normal.woff`));
    f = { bytes, kit: fontkit.create(bytes) as unknown as Kit };
    fontFiles.set(key, f);
  }
  return f;
}

/** Splits text into runs that one face can draw; characters no face has become "?". */
export function fontRuns(text: string, weight: Weight): { subset: string; text: string }[] {
  const runs: { subset: string; text: string }[] = [];
  for (const ch of text.replace(/\t/g, '    ')) {
    const cp = ch.codePointAt(0)!;
    // Zero-width joiners and combining marks stay with the run before them.
    const sticky = cp === 0x200c || cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f);
    const last = runs[runs.length - 1];
    if (sticky && last) { last.text += ch; continue; }
    const subset = SUBSETS.find((s) => face(s, weight).kit.hasGlyphForCodePoint(cp));
    const out = subset ? ch : '?';
    const use = subset ?? 'latin';
    if (last && last.subset === use) last.text += out; else runs.push({ subset: use, text: out });
  }
  return runs;
}

/** The fonts of one document, embedded on first use. */
class Fonts {
  private embedded = new Map<string, PDFFont>();
  constructor(private readonly pdf: PDFDocument) {}
  async prepare(texts: string[], weights: Weight[]) {
    for (const w of weights) for (const t of texts) for (const r of fontRuns(t, w)) await this.font(r.subset, w);
  }
  private async font(subset: string, w: Weight) {
    const key = `${subset}-${w}`;
    let f = this.embedded.get(key);
    if (!f) {
      f = await this.pdf.embedFont(face(subset, w).bytes, { subset: true });
      this.embedded.set(key, f);
    }
    return f;
  }
  get(subset: string, w: Weight): PDFFont {
    const f = this.embedded.get(`${subset}-${w}`);
    if (!f) throw new Error(`font ${subset}-${w} was not prepared`);
    return f;
  }
  width(text: string, size: number, w: Weight) {
    return fontRuns(text, w).reduce((sum, r) => sum + this.get(r.subset, w).widthOfTextAtSize(r.text, size), 0);
  }
  draw(page: PDFPage, text: string, x: number, y: number, size: number, w: Weight, color: ReturnType<typeof rgb>) {
    for (const r of fontRuns(text, w)) {
      const font = this.get(r.subset, w);
      page.drawText(r.text, { x, y, size, font, color });
      x += font.widthOfTextAtSize(r.text, size);
    }
  }
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
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${d.code} ${d.title}`);
  pdf.setAuthor(d.workspace);
  pdf.setSubject('Staffing proposal');
  pdf.setProducer('CREW by SAMPLEDGE');
  pdf.setCreationDate(new Date(`${d.issuedOn}T00:00:00Z`));
  const fonts = new Fonts(pdf);
  const regular: Weight = 400;
  const bold: Weight = 700;
  // Every string the proposal can print, so each face it needs is embedded once up front.
  const money0 = (v: string) => `${d.currency} ${formatAmount(v, d.currency)}`;
  await fonts.prepare([
    d.workspace, d.code, d.title, d.coverNote, d.terms, d.preparedBy, d.client.name, d.client.legalName ?? '', d.client.contactName ?? '', d.client.address ?? '',
    'Staffing proposal Prepared for Attention: Role Location People Monthly rate each Per month Monthly total Term Contract value Terms Amounts exclude applicable taxes. Issued valid until version Page of person people month months from - . , : 0123456789',
    ...d.pricing.lines.flatMap((l) => [l.roleTitle, l.location ?? '-', money0(l.billMonthly), money0(l.monthlyRevenue)]),
    money0(d.pricing.monthlyRevenue), money0(d.pricing.contractRevenue),
  ], [regular, bold]);

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
  const text = (s: string, x: number, size: number, font: Weight = regular, color = INK) => {
    fonts.draw(page, s, x, y, size, font, color);
  };
  const right = (s: string, xRight: number, size: number, font: Weight = regular, color = INK) => {
    fonts.draw(page, s, xRight - fonts.width(s, size, font), y, size, font, color);
  };
  const wrap = (s: string, size: number, font: Weight, max: number): string[] => {
    const out: string[] = [];
    for (const para of s.replace(/\r/g, '').split('\n')) {
      if (!para.trim()) { out.push(''); continue; }
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (fonts.width(next, size, font) > max && line) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  };
  const paragraph = (s: string, size = 10, font: Weight = regular, color = INK) => {
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
  right(`${d.code} - version ${d.version}`, M + width, 9, regular, MUTED);
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
  // Role, location, then right edges of people, rate and monthly amount.
  const cols = [M, M + 185, M + 265, M + 305, M + width];
  const RATE = M + 400;
  const header = () => {
    ensure(40);
    page.drawRectangle({ x: M, y: y - 6, width, height: 20, color: rgb(0.95, 0.95, 0.98) });
    text('Role', cols[0]! + 6, 9, bold, MUTED);
    text('Location', cols[1]!, 9, bold, MUTED);
    right('People', cols[3]! - 6, 9, bold, MUTED);
    right('Monthly rate each', RATE, 9, bold, MUTED);
    right('Per month', cols[4]! - 6, 9, bold, MUTED);
    y -= 24;
  };
  header();
  for (const l of d.pricing.lines) {
    const roleLines = wrap(l.roleTitle, 10, regular, 175);
    const h = Math.max(roleLines.length, Math.min(2, wrap(l.location ?? '-', 10, regular, 75).length)) * 13 + 6;
    if (y - h < M + 24) { newPage(); header(); }
    const top = y;
    roleLines.forEach((r, i) => { y = top - i * 13; text(r, cols[0]! + 6, 10); });
    y = top;
    wrap(l.location ?? '-', 10, regular, 75).slice(0, 2).forEach((r, i) => { y = top - i * 13; text(r, cols[1]!, 10, regular, MUTED); });
    y = top;
    right(String(l.headcount), cols[3]! - 6, 10);
    right(money(l.billMonthly), RATE, 10);
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
    fonts.draw(p, `Prepared by ${d.preparedBy}, ${d.workspace}`, M, 28, 8, regular, MUTED);
    const n = `Page ${i + 1} of ${pages.length}`;
    fonts.draw(p, n, M + width - fonts.width(n, 8, regular), 28, 8, regular, MUTED);
  });
  return Buffer.from(await pdf.save());
}

export interface AcceptanceRecord {
  code: string; version: number; clientName: string; workspace: string;
  signerName: string; signerTitle: string; signerEmail: string; signature: string;
  acceptedAt: string; ip: string | null; userAgent: string | null; pdfSha256: string; linkSentTo: string;
}

/**
 * The signed copy: the proposal exactly as sent, with a final page recording the acceptance (the typed
 * signature, the signer, when and from where, and the SHA-256 of the proposal PDF they accepted).
 */
export async function appendAcceptance(original: Buffer, a: AcceptanceRecord): Promise<Buffer> {
  const pdf = await PDFDocument.load(original);
  pdf.registerFontkit(fontkit);
  const fonts = new Fonts(pdf);
  const rows: [string, string][] = [
    ['Proposal', `${a.code}, version ${a.version}`],
    ['Client', a.clientName],
    ['Accepted by', `${a.signerName}, ${a.signerTitle}`],
    ['Email', a.signerEmail],
    ['Accepted at', a.acceptedAt],
    ['Link sent to', a.linkSentTo],
    ['IP address', a.ip ?? 'Not recorded'],
    ['Browser', (a.userAgent ?? 'Not recorded').slice(0, 90)],
    ['Proposal SHA-256', a.pdfSha256],
  ];
  const intro = `${a.signerName} accepted this proposal online on behalf of ${a.clientName}, confirming they are authorised to do so, by typing their name as their signature.`;
  await fonts.prepare(['Acceptance record', intro, a.signature, 'Signature', 'Recorded by CREW for', a.workspace, ...rows.flat()], [400, 700]);
  const page = pdf.addPage(A4);
  let y = A4[1] - M;
  const width = A4[0] - 2 * M;
  fonts.draw(page, 'Acceptance record', M, y, 16, 700, INK);
  y -= 28;
  // Wrap the introduction.
  let line = '';
  for (const word of intro.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (fonts.width(next, 10, 400) > width && line) { fonts.draw(page, line, M, y, 10, 400, INK); y -= 14; line = word; } else line = next;
  }
  if (line) { fonts.draw(page, line, M, y, 10, 400, INK); y -= 24; }
  for (const [k, v] of rows) {
    fonts.draw(page, k, M, y, 9, 700, MUTED);
    fonts.draw(page, v, M + 120, y, k === 'Proposal SHA-256' ? 7.5 : 10, 400, INK);
    y -= 18;
  }
  y -= 16;
  fonts.draw(page, 'Signature', M, y, 9, 700, MUTED);
  y -= 30;
  fonts.draw(page, a.signature, M, y, 22, 400, ACCENT);
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.75, color: RULE });
  fonts.draw(page, `Recorded by CREW for ${a.workspace}`, M, 28, 8, 400, MUTED);
  return Buffer.from(await pdf.save());
}
