import { describe, expect, it } from 'vitest';
import { appRoute, money } from './format';

describe('money', () => {
  it('groups INR the Indian way and keeps the exact decimals', () => {
    expect(money('1234567.5', 'INR')).toBe('₹12,34,567.50');
    expect(money('24150.00', 'INR')).toBe('₹24,150.00');
    expect(money('999', 'INR')).toBe('₹999.00');
    expect(money('-1700.00', 'INR')).toBe('-₹1,700.00');
  });
  it('groups other currencies in thousands', () => {
    expect(money('1234567.89', 'USD')).toBe('USD 1,234,567.89');
    expect(money('0.1', 'USD')).toBe('USD 0.10');
  });
  it('never rounds through floating point', () => {
    expect(money('99999999999999999.99', 'USD')).toBe('USD 99,999,999,999,999,999.99');
  });
});

describe('appRoute', () => {
  const id = '3f3fbc79-7481-4be6-b8bb-d2794d769ee0';
  it('maps notification links to app screens', () => {
    expect(appRoute(`/payslips/${id}`)).toBe(`/payslips/${id}`);
    expect(appRoute(`/helpdesk/${id}`)).toBe(`/helpdesk/${id}`);
    expect(appRoute(`/announcements/${id}`)).toBe(`/announcements/${id}`);
    expect(appRoute('/expenses?view=approvals')).toBe('/approvals');
    expect(appRoute('/leave')).toBe('/leave');
  });
  it('returns null for screens the app does not have', () => {
    expect(appRoute('/recruitment/jobs/1')).toBeNull();
    expect(appRoute(null)).toBeNull();
    expect(appRoute('/payslips/../../x')).toBe('/me');
  });
});
