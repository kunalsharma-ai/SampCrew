import { describe, expect, it } from 'vitest';
import { addPeriod, daysBetween, financialYear, monthlyValue, periodAmount, prorate, taxFor, upgradeQuote, usagePercent, type TaxSettings } from './billing-math';
import { billingProfileInput, couponCreate } from './schemas/billing';

const GST: TaxSettings = { gstRate: '18', exportZeroRated: true, otherTaxRate: '0', otherTaxLabel: 'Tax' };
const seller = { countryCode: 'IN', stateCode: '27', gstin: '27AAPFU0939F1ZV' };

describe('billing periods', () => {
  it('adds calendar months and years, keeping month ends', () => {
    expect(addPeriod('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(addPeriod('2028-01-31', 'monthly')).toBe('2028-02-29');
    expect(addPeriod('2026-11-10', 'monthly')).toBe('2026-12-10');
    expect(addPeriod('2026-12-10', 'monthly')).toBe('2027-01-10');
    expect(addPeriod('2028-02-29', 'annual')).toBe('2029-02-28');
    expect(daysBetween('2026-11-01', '2026-12-01')).toBe(30);
  });

  it('prices a period and its monthly value', () => {
    expect(periodAmount('499.00', 50, 'monthly')).toBe('24950.00');
    expect(periodAmount('399.00', 50, 'annual')).toBe('239400.00');
    expect(monthlyValue('239400.00', 'annual')).toBe('19950.00');
  });
});

describe('proration', () => {
  it('charges the difference for the days left in the period', () => {
    // 30-day period, 15 days left: half of each amount.
    const q = upgradeQuote({ currentAmount: '14950.00', newAmount: '24950.00', periodStart: '2026-11-01', periodEnd: '2026-12-01', today: '2026-11-16', currentCycle: 'monthly', newCycle: 'monthly' });
    expect(q).toEqual({ dueNow: '5000.00', credit: '7475.00', charge: '12475.00', periodStart: '2026-11-01', periodEnd: '2026-12-01' });
  });

  it('starts a new period when the cycle changes, crediting the unused part', () => {
    const q = upgradeQuote({ currentAmount: '3000.00', newAmount: '28800.00', periodStart: '2026-11-01', periodEnd: '2026-12-01', today: '2026-11-11', currentCycle: 'monthly', newCycle: 'annual' });
    expect(q.credit).toBe('2000.00');
    expect(q.dueNow).toBe('26800.00');
    expect([q.periodStart, q.periodEnd]).toEqual(['2026-11-11', '2027-11-11']);
  });

  it('gives no credit for an unpaid period (trial) and never goes below zero', () => {
    expect(upgradeQuote({ currentAmount: '1000.00', newAmount: '2000.00', periodStart: '2026-11-01', periodEnd: '2026-12-01', today: '2026-11-16', currentCycle: 'monthly', newCycle: 'monthly', noCredit: true }).dueNow).toBe('2000.00');
    expect(upgradeQuote({ currentAmount: '2000.00', newAmount: '1000.00', periodStart: '2026-11-01', periodEnd: '2026-12-01', today: '2026-11-16', currentCycle: 'monthly', newCycle: 'monthly' }).dueNow).toBe('0.00');
    expect(prorate('100.00', '2026-11-01', '2026-12-01', '2026-12-05')).toBe('0.00');
  });
});

describe('GST', () => {
  it('splits CGST and SGST within a state', () => {
    const t = taxFor('1000.00', seller, { countryCode: 'IN', stateCode: '27', gstin: null }, GST);
    expect(t.lines.map((l) => [l.label, l.rate, l.amount])).toEqual([['CGST', '9', '90.00'], ['SGST', '9', '90.00']]);
    expect(t.total).toBe('180.00');
    expect(t.placeOfSupply).toBe('Maharashtra (27)');
  });

  it('charges IGST between states, reading the state from the buyer GSTIN', () => {
    const t = taxFor('1000.00', seller, { countryCode: 'IN', stateCode: '27', gstin: '29ABCDE1234F1Z5' }, GST);
    expect(t.lines).toEqual([{ code: 'igst', label: 'IGST', rate: '18', amount: '180.00' }]);
    expect(t.placeOfSupply).toBe('Karnataka (29)');
  });

  it('zero-rates exports under a LUT, or charges IGST when that is off', () => {
    const t = taxFor('1000.00', seller, { countryCode: 'US', stateCode: null, gstin: null }, GST);
    expect(t.total).toBe('0.00');
    expect(t.note).toMatch(/export/);
    expect(taxFor('1000.00', seller, { countryCode: 'US', stateCode: null, gstin: null }, { ...GST, exportZeroRated: false }).total).toBe('180.00');
  });

  it('uses the flat tax for a seller without a GSTIN', () => {
    expect(taxFor('1000.00', { countryCode: 'GB', stateCode: null, gstin: null }, { countryCode: 'GB', stateCode: null, gstin: null }, { ...GST, otherTaxRate: '20', otherTaxLabel: 'VAT' }).lines).toEqual([{ code: 'tax', label: 'VAT', rate: '20', amount: '200.00' }]);
    expect(taxFor('1000.00', { countryCode: 'US', stateCode: null, gstin: null }, { countryCode: 'US', stateCode: null, gstin: null }, GST).lines).toEqual([]);
  });

  it('numbers invoices by Indian financial year', () => {
    expect(financialYear('2026-11-10')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2027-04-01')).toBe('2027-28');
  });
});

describe('inputs', () => {
  it('checks the GSTIN against the state', () => {
    const base = { legalName: 'Acme Pvt Ltd', addressLine1: '1 Main Road', city: 'Pune', postalCode: '411001', countryCode: 'IN', email: 'ap@acme.test' };
    expect(billingProfileInput.safeParse({ ...base, stateCode: '27', gstin: '27aapfu0939f1zv' }).success).toBe(true);
    expect(billingProfileInput.safeParse({ ...base, stateCode: '29', gstin: '27AAPFU0939F1ZV' }).success).toBe(false);
    expect(billingProfileInput.safeParse({ ...base }).success).toBe(false);
  });

  it('needs a currency for an amount coupon and cycles for a repeating one', () => {
    expect(couponCreate.safeParse({ code: 'WELCOME10', name: 'Welcome', kind: 'percent', value: '10', duration: 'once' }).success).toBe(true);
    expect(couponCreate.safeParse({ code: 'FLAT', name: 'Flat', kind: 'amount', value: '500', duration: 'once' }).success).toBe(false);
    expect(couponCreate.safeParse({ code: 'THREE', name: 'Three', kind: 'percent', value: '10', duration: 'repeating' }).success).toBe(false);
  });

  it('reports usage percentages', () => {
    expect(usagePercent(80, 100)).toBe(80);
    expect(usagePercent(5, -1)).toBeNull();
    expect(usagePercent(1, 0)).toBe(100);
  });
});
