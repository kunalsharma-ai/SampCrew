import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Response } from 'express';
import { contentDisposition } from '../http/content-disposition';

/**
 * Tables for download: CSV (as the lists already produce) and Excel (.xlsx). An .xlsx file is a zip of a few XML
 * parts; this writes the smallest valid workbook with one sheet, a bold frozen header row and sensible column
 * widths. Cells are written as inline text or numbers, never formulas, so nothing in the data can run.
 */

export type Cell = string | number | null | undefined | TypedCell;

/**
 * A real date, time or duration in a workbook (Excel and Google Sheets sort and filter it as one). `v` is the Excel
 * serial number for dates and times (days since 1899-12-30, the time as the fraction of a day) and hours for 'hours'.
 * In CSV it is written as text in ISO form.
 */
export interface TypedCell { t: 'date' | 'datetime' | 'time' | 'hours'; v: number; text: string }

/** Excel serial number of a local date and minutes after midnight. */
export function excelSerial(date: string, minutes = 0): number {
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
  return days + minutes / 1440;
}
export const xDate = (date: string): TypedCell => ({ t: 'date', v: excelSerial(date), text: date });
export const xDateTime = (date: string, minutes: number): TypedCell => ({ t: 'datetime', v: excelSerial(date, minutes), text: `${date} ${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` });
export const xTime = (minutes: number): TypedCell => ({ t: 'time', v: minutes / 1440, text: `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` });
export const xHours = (minutes: number): TypedCell => ({ t: 'hours', v: Math.round((minutes / 60) * 100) / 100, text: (Math.round((minutes / 60) * 100) / 100).toFixed(2) });
const isTyped = (v: Cell): v is TypedCell => typeof v === 'object' && v !== null && 't' in v;
/** A cell as text (CSV). */
export const cellText = (v: Cell): string => (v === null || v === undefined ? '' : isTyped(v) ? v.text : String(v));
const STYLE = { date: 2, datetime: 3, time: 4, hours: 5 } as const;

/** Parses CSV as the export services write it (RFC 4180, CRLF, optional BOM) back into rows. */
export function parseCsv(content: string): string[][] {
  const text = content.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Characters XML 1.0 cannot carry.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** "A", "B", ... "Z", "AA" ... */
export function columnName(i: number) {
  let n = i + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Whether a text cell should be stored as a number: plain decimals only. Codes with leading zeros, long digit
 * strings (phone and account numbers) and anything else stay text, so nothing is silently changed.
 */
export function numeric(v: string) {
  return /^-?(0|[1-9]\d{0,14})(\.\d{1,6})?$/.test(v) && v.replace(/[-.]/g, '').length <= 15;
}

function sheetXml(rows: Cell[][], header = 0, filter = false): string {
  const widths: number[] = [];
  let maxCols = 0;
  const body = rows.map((r, ri) => {
    maxCols = Math.max(maxCols, r.length);
    const cells = r.map((v, ci) => {
      const ref = `${columnName(ci)}${ri + 1}`;
      if (v === null || v === undefined || v === '') return '';
      if (isTyped(v)) {
        widths[ci] = Math.max(widths[ci] ?? 8, v.t === 'datetime' ? 18 : 12);
        return `<c r="${ref}" s="${STYLE[v.t]}"><v>${v.v}</v></c>`;
      }
      let text = String(v);
      // Title rows above the header do not widen the columns.
      if (ri >= header) widths[ci] = Math.max(widths[ci] ?? 8, Math.min(60, text.length + 2));
      if (ri > header && (typeof v === 'number' || numeric(text))) return `<c r="${ref}"><v>${Number(text)}</v></c>`;
      // The CSV writers prefix possible formulas with an apostrophe; in a workbook text is never a formula.
      if (/^'[=+\-@]/.test(text)) text = text.slice(1);
      const bold = ri === header || (header > 0 && ri === 0);
      return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const cols = widths.length ? `<cols>${Array.from(widths, (w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w ?? 10}" customWidth="1"/>`).join('')}</cols>` : '';
  const top = header + 1;
  const auto = filter && rows.length > top && maxCols ? `<autoFilter ref="A${top}:${columnName(maxCols - 1)}${rows.length}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${top}" topLeftCell="A${top + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${body}</sheetData>${auto}</worksheet>`;
}

const sheetTitle = (s: string, i: number) => esc(s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);

export function toXlsx(sheetName: string, rows: Cell[][]): Buffer {
  return toXlsxBook([{ name: sheetName, rows }]);
}

/**
 * A workbook with several sheets (each with a bold frozen header row). Sheet names must differ; they are cut to
 * Excel's 31 characters and characters Excel refuses are replaced.
 */
export function toXlsxBook(sheets: { name: string; rows: Cell[][]; header?: number; filter?: boolean }[]): Buffer {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((s, i) => `<sheet name="${sheetTitle(s.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="166" formatCode="hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="6"><xf fontId="0" xfId="0"/><xf fontId="1" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
  };
  list.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows, s.header ?? 0, s.filter ?? false)); });
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** A CSV export as an Excel workbook with the same rows. */
export const csvToXlsx = (sheetName: string, csv: string) => toXlsx(sheetName, parseCsv(csv));

export function sendFile(res: Response, f: { fileName: string; content: string | Buffer }, format: 'csv' | 'xlsx', sheetName = 'Export') {
  if (format === 'xlsx') {
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', contentDisposition('attachment', f.fileName.replace(/\.csv$/, '.xlsx')));
    res.setHeader('cache-control', 'private, no-store');
    res.send(typeof f.content === 'string' ? csvToXlsx(sheetName, f.content) : f.content);
    return;
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
  res.setHeader('cache-control', 'private, no-store');
  res.send(f.content);
}

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

/** Column letters of a cell reference ("C12") to a zero-based index. */
function columnIndex(ref: string) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Reads the first sheet of an Excel workbook (.xlsx) as rows of text, as typed: shared and inline strings, numbers
 * (dates come through as Excel serial numbers) and booleans. Formulas give their last calculated value. Nothing is
 * evaluated. Throws on a file that is not a workbook.
 */
export function readXlsx(buf: Buffer, maxRows = 10_000, sheetIndex = 0): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.startsWith('xl/') && f.name.endsWith('.xml') || f.name.endsWith('.rels') });
  } catch {
    throw new Error('not_xlsx');
  }
  const text = (name: string) => (files[name] ? strFromU8(files[name]!) : null);
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('not_xlsx');
  const firstSheetRid = [...workbook.matchAll(/<sheet\b[^>]*\br:id="([^"]+)"/g)][sheetIndex]?.[1];
  if (sheetIndex > 0 && !firstSheetRid) throw new Error('not_xlsx');
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  let target = 'worksheets/sheet1.xml';
  if (firstSheetRid) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${firstSheetRid}"[^>]*>`).exec(rels)?.[0];
    const t = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (t) target = t.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const sheet = text(`xl/${target}`);
  if (!sheet) throw new Error('not_xlsx');
  const shared: string[] = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst) {
    for (const si of sst.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
      shared.push(unesc((si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const rows: string[][] = [];
  for (const rowXml of sheet.match(/<row\b[\s\S]*?(?:<\/row>|\/>)/g) ?? []) {
    if (rows.length >= maxRows) break;
    const rowNum = Number(/\br="(\d+)"/.exec(rowXml)?.[1] ?? rows.length + 1);
    const row: string[] = [];
    for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1] ?? '';
      const inner = m[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = unesc((inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else value = v !== undefined ? unesc(v) : '';
      row[ref ? columnIndex(ref) : row.length] = value;
    }
    while (rows.length < rowNum - 1) rows.push([]);
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows;
}
