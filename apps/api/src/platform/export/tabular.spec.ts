import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { columnName, csvToXlsx, numeric, parseCsv } from './tabular';

describe('tabular export', () => {
  it('reads CSV back with quotes, commas, new lines and a BOM', () => {
    expect(parseCsv('﻿Name,Note\r\n"Shah, Divya","said ""hi""\nthen left"\r\n')).toEqual([['Name', 'Note'], ['Shah, Divya', 'said "hi"\nthen left']]);
  });
  it('keeps codes, phone numbers and formulas as text and plain amounts as numbers', () => {
    expect(['45000', '45000.50', '-12', '0'].every(numeric)).toBe(true);
    expect(['0012', '919876543210123456', '1e5', '12,000', ''].some(numeric)).toBe(false);
    expect([0, 25, 26, 701].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ']);
  });
  it('writes a workbook with a bold, frozen header row', () => {
    const files = unzipSync(new Uint8Array(csvToXlsx('People', "Name,Code,Pay,Note\r\nAsha,0012,45000.5,'=HYPERLINK(1)\r\n")));
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Name</t></is></c>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">0012</t></is></c>');
    expect(sheet).toContain('<c r="C2"><v>45000.5</v></c>');
    expect(sheet).toContain('=HYPERLINK(1)</t>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('state="frozen"');
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('name="People"');
  });
});
