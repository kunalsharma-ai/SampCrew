import { describe, expect, it } from 'vitest';
import { contentDisposition } from './content-disposition';

// Node's own header check: the value must be one Node will send.
import { validateHeaderValue } from 'node:http';

describe('contentDisposition', () => {
  it('keeps plain names', () => {
    expect(contentDisposition('attachment', 'payslip-2026-10.pdf')).toBe(`attachment; filename="payslip-2026-10.pdf"; filename*=UTF-8''payslip-2026-10.pdf`);
  });
  it('sends names in any language as a valid header', () => {
    for (const n of ['वेतन पर्ची.pdf', 'Lohnzettel März.pdf', '給与明細.pdf', 'a"b;c%d.pdf', 'line\r\nbreak.pdf', '../../etc/passwd', '']) {
      const h = contentDisposition('attachment', n);
      expect(() => validateHeaderValue('content-disposition', h), n).not.toThrow();
      expect(h).not.toMatch(/[\r\n]/);
      expect(h).not.toContain('/');
    }
    expect(contentDisposition('inline', 'Lohnzettel März.pdf')).toContain(`filename*=UTF-8''Lohnzettel%20M%C3%A4rz.pdf`);
    expect(contentDisposition('inline', 'Lohnzettel März.pdf')).toContain('filename="Lohnzettel Marz.pdf"');
  });
});

import { safeFileName } from './content-disposition';

describe('safeFileName', () => {
  it('keeps names in every language, including ones the upload parser garbled', () => {
    expect(safeFileName('वेतन पर्ची.pdf', 'file')).toBe('वेतन पर्ची.pdf');
    expect(safeFileName(Buffer.from('वेतन पर्ची.pdf', 'utf8').toString('latin1'), 'file')).toBe('वेतन पर्ची.pdf');
    expect(safeFileName(Buffer.from('Lohnzettel März.pdf', 'utf8').toString('latin1'), 'file')).toBe('Lohnzettel März.pdf');
    expect(safeFileName('Lohnzettel März.pdf', 'file')).toBe('Lohnzettel März.pdf');
  });
  it('removes what could be read as a path or break a header', () => {
    expect(safeFileName('../../etc/passwd', 'file')).toBe('_.._etc_passwd');
    expect(safeFileName('a\r\nb<>:"|?*.pdf', 'file')).toBe('a_b_.pdf');
    expect(safeFileName('', 'cv')).toBe('cv');
    expect(safeFileName('...', 'cv')).toBe('cv');
  });
});
