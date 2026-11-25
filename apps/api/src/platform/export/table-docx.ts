import { strToU8, zipSync } from 'fflate';
import type { Cell } from './tabular';

/**
 * A report as a Word document (.docx): a title, a subtitle line, then one table per section with a bold, repeated
 * header row, on landscape A4. A .docx is a zip of a few WordprocessingML parts; this writes the smallest valid
 * document, with every cell as plain text (nothing in the data can become a field or a macro).
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Characters XML 1.0 cannot carry.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const text = (v: Cell) => (v === null || v === undefined ? '' : String(v)).replace(/^'([=+\-@])/, '$1');

const run = (s: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
  `<w:r><w:rPr>${opts.bold ? '<w:b/>' : ''}${opts.color ? `<w:color w:val="${opts.color}"/>` : ''}<w:sz w:val="${opts.size ?? 16}"/></w:rPr><w:t xml:space="preserve">${esc(s)}</w:t></w:r>`;

const para = (s: string, opts: { bold?: boolean; size?: number; color?: string; after?: number } = {}) =>
  `<w:p><w:pPr><w:spacing w:after="${opts.after ?? 120}"/></w:pPr>${run(s, opts)}</w:p>`;

function table(rows: Cell[][]): string {
  const [header = [], ...body] = rows;
  const cols = Math.max(1, header.length);
  const cell = (v: Cell, head: boolean) =>
    `<w:tc><w:tcPr>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F2F5"/>' : ''}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(text(v), { bold: head, size: 15 })}</w:p></w:tc>`;
  const row = (r: Cell[], head: boolean) =>
    `<w:tr>${head ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${Array.from({ length: cols }, (_, i) => cell(r[i], head)).join('')}</w:tr>`;
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="DADCE2"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="autofit"/><w:tblCellMar><w:left w:w="60" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${'<w:gridCol/>'.repeat(cols)}</w:tblGrid>${row(header, true)}${body.map((r) => row(r, false)).join('')}</w:tbl>`;
}

export function renderTableDocx(title: string, subtitle: string, sections: { name: string; rows: Cell[][] }[]): Buffer {
  const parts = [para(title, { bold: true, size: 32, after: 60 }), para(subtitle, { size: 18, color: '6B7280', after: 240 })];
  sections.forEach((s, i) => {
    if (sections.length > 1 || s.name) parts.push(para(s.name, { bold: true, size: 22, after: 80 }));
    parts.push(table(s.rows));
    if (i < sections.length - 1) parts.push(para('', { after: 240 }));
  });
  // Landscape A4 (in twentieths of a point) with 1.27 cm margins.
  const sect = '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}${sect}</w:body></w:document>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'docProps/core.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>SampCrew</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`),
    'word/document.xml': strToU8(document),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
