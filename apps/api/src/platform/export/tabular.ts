import { strToU8, zipSync } from 'fflate';
import type { Response } from 'express';
import { contentDisposition } from '../http/content-disposition';

/**
 * Tables for download: CSV (as the lists already produce) and Excel (.xlsx). An .xlsx file is a zip of a few XML
 * parts; this writes the smallest valid workbook with one sheet, a bold frozen header row and sensible column
 * widths. Cells are written as inline text or numbers, never formulas, so nothing in the data can run.
 */

export type Cell = string | number | null | undefined;

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

export function toXlsx(sheetName: string, rows: Cell[][]): Buffer {
  const name = esc(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1');
  const widths: number[] = [];
  const body = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      const ref = `${columnName(ci)}${ri + 1}`;
      if (v === null || v === undefined || v === '') return '';
      let text = String(v);
      widths[ci] = Math.max(widths[ci] ?? 8, Math.min(60, text.length + 2));
      if (ri > 0 && (typeof v === 'number' || numeric(text))) return `<c r="${ref}"><v>${Number(text)}</v></c>`;
      // The CSV writers prefix possible formulas with an apostrophe; in a workbook text is never a formula.
      if (/^'[=+\-@]/.test(text)) text = text.slice(1);
      return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w ?? 10}" customWidth="1"/>`).join('')}</cols>` : '';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${body}</sheetData></worksheet>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" xfId="0"/><xf fontId="1" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };
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
