import { priceBid } from '@crew/contracts';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { fontRuns, renderProposal } from '../src/modules/bids/proposal-pdf';

/** The proposal PDF prints names in the scripts CREW customers use, not just Western European ones. */
describe('proposal PDF fonts', () => {
  it('picks a face per script and marks only what no face has', () => {
    const runs = fontRuns('Meera राहुल शर्मा Ωμέγα Жуков Nguyễn ₹ 中', 400);
    const by = (t: string) => runs.find((r) => r.text.includes(t))?.subset;
    expect(by('Meera')).toBe('latin');
    expect(by('राहुल')).toBe('devanagari');
    expect(by('Ωμέγα')).toBe('greek');
    expect(by('Жуков')).toBe('cyrillic');
    expect(['latin', 'latin-ext', 'vietnamese']).toContain(by('ễ'));
    expect(runs.map((r) => r.text).join('')).toContain('?'); // 中 is not covered
    expect(runs.map((r) => r.text).join('').replace('?', '中')).toBe('Meera राहुल शर्मा Ωμέγα Жуков Nguyễn ₹ 中');
  });

  it('renders a proposal for a client with a Hindi name and embeds only the faces it uses', async () => {
    const lines = [{ roleTitle: 'सुरक्षा गार्ड (Security guard)', headcount: 4, location: 'पुणे', payMonthly: '20000' }];
    const pricing = priceBid({ lines, onCostPct: '13', overheadPct: '5', targetMarginPct: '18', durationMonths: 6 });
    const pdf = await renderProposal({
      workspace: 'Northwind Staffing', code: 'BID-0007', version: 1, title: 'सुरक्षा सेवाएँ for Ādhya Logistics', issuedOn: '2026-11-01', validUntil: '2026-12-01',
      client: { name: 'आध्या लॉजिस्टिक्स', legalName: null, contactName: 'श्रीमती मेहता', address: 'Hinjewadi, Pune' }, currency: 'INR', startDate: '2026-12-01',
      durationMonths: 6, coverNote: 'नमस्ते — please find our proposal “below”.', terms: 'Net 30.', preparedBy: 'Kabir Shah', pricing,
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getTitle()).toBe('BID-0007 सुरक्षा सेवाएँ for Ādhya Logistics');
    const fonts: string[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font') && obj.get(PDFName.of('Subtype')) === PDFName.of('Type0')) {
        fonts.push(String(obj.get(PDFName.of('BaseFont'))));
      }
    }
    // Subsets of Noto Sans only, no standard Helvetica; Latin, Latin Extended and Devanagari faces in two weights at most, nothing for scripts the text does not use.
    expect(fonts.length).toBeGreaterThanOrEqual(3);
    expect(fonts.length).toBeLessThanOrEqual(6);
    expect(fonts.every((f) => /NotoSans/.test(f))).toBe(true);
  });
});
