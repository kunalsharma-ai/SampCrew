import { renderTablePdf } from '../../platform/export/table-pdf';
import { toXlsx, type Cell } from '../../platform/export/tabular';

export interface TableFile { fileName: string; content: string | Buffer; type: string }

/** A Console table (header row first) as a CSV, Excel or PDF download. CSV cells that look like formulas are quoted. */
export async function tableFile(base: string, title: string, subtitle: string, rows: Cell[][], format: 'csv' | 'xlsx' | 'pdf'): Promise<TableFile> {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'pdf') return { fileName: `${base}-${stamp}.pdf`, content: await renderTablePdf(title, subtitle, rows), type: 'application/pdf' };
  if (format === 'xlsx') return { fileName: `${base}-${stamp}.xlsx`, content: toXlsx(title.slice(0, 31), rows), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  const csv = rows
    .map((r) => r.map((v) => {
      const t = v == null ? '' : String(v);
      const safe = /^[=+\-@]/.test(t) ? `'${t}` : t;
      return /[",\n\r]/.test(safe) || safe !== t ? `"${safe.replace(/"/g, '""')}"` : t;
    }).join(','))
    .join('\r\n');
  return { fileName: `${base}-${stamp}.csv`, content: `﻿${csv}\r\n`, type: 'text/csv; charset=utf-8' };
}
