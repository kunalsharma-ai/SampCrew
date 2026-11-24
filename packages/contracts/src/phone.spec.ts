import { describe, expect, it } from 'vitest';
import {
  addYears, ageOn, catalogueDesignation, checkPhone, createEmployeeInput, dateOfBirthError, dateOfBirthRange, designationLibrary, earliestJoining,
  isMinorOn, phoneError, phoneNumber, setupCompanyInput, signatureOptionsInput, suggestedDesignations, INDUSTRIES, updateEmployeeInput,
} from './index';

const ENTITY = '11111111-1111-4111-8111-111111111111';
const LEAVE = '22222222-2222-4222-8222-222222222222';
const hire = (extra: Record<string, unknown>) => createEmployeeInput.safeParse({ firstName: 'Asha', legalEntityId: ENTITY, dateOfJoining: '2026-11-18', ...extra });
const issues = (r: ReturnType<typeof hire>) => (r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])));

describe('phone numbers', () => {
  it('accepts real numbers with a country code, in any common spacing', () => {
    for (const n of ['+91 98201 23456', '+919820123456', '+91-98201-23456', '0091 98201 23456', '+91 20 2612 3456', '+1 (415) 555-2671', '+44 7700 900123',
      '+44 20 7946 0958', '+971 50 123 4567', '+966 50 123 4567', '+974 3312 3456', '+65 6123 4567', '+61 412 345 678', '+49 30 901820', '+33 1 42 68 53 00']) {
      expect(checkPhone(n), n).toMatchObject({ ok: true });
    }
  });

  it('turns a known country number into its international form', () => {
    expect(checkPhone('+91 98201 23456')).toEqual({ ok: true, value: '+91 98201 23456', e164: '+919820123456' });
    expect(checkPhone('098201 23456', 'IN')).toMatchObject({ ok: true, e164: '+919820123456' });
    expect(checkPhone('98201 23456', 'IN')).toMatchObject({ ok: true, e164: '+919820123456' });
    expect(checkPhone('07700 900123', 'GB')).toMatchObject({ ok: true, e164: '+447700900123' });
    expect(checkPhone('(415) 555-2671', 'US')).toMatchObject({ ok: true, e164: '+14155552671' });
  });

  it('rejects letters, misplaced +, wrong lengths and placeholder numbers', () => {
    expect(phoneError('98201abc56')).toMatch(/only digits/);
    expect(phoneError('98+201 23456')).toMatch(/\+ can only come first/);
    expect(phoneError('+91 98201 2345')).toMatch(/9 digits after \+91; numbers there have 10/);
    expect(phoneError('+91 98201 234560')).toMatch(/11 digits after \+91/);
    expect(phoneError('+91 01234 56789')).toMatch(/not a valid \+91 number/);
    expect(phoneError('+1 015 555 2671')).toMatch(/not a valid \+1 number/);
    expect(phoneError('+91 99999 99999')).toMatch(/not a valid/);
    expect(phoneError('0000000000')).toMatch(/real phone number/);
    expect(phoneError('1234567890')).toMatch(/real phone number/);
    expect(phoneError('12345')).toMatch(/country code/);
    expect(phoneError('+12 34')).toMatch(/8 to 15 digits/);
    expect(phoneError('9876 5432', 'IN')).toMatch(/8 digits; numbers there have 10/);
    expect(phoneError('7700 900123', 'GB')).toMatch(/Start with 0 or the country code/);
    expect(phoneError('(98201 23456')).toMatch(/Close the bracket/);
  });

  it('treats an empty optional value as no number', () => {
    expect(phoneError('')).toBeNull();
    expect(phoneError(null)).toBeNull();
    expect(phoneNumber.safeParse('  +91  98201   23456 ')).toEqual({ success: true, data: '+91 98201 23456' });
  });

  it('every form schema with a phone uses the same rules', () => {
    expect(hire({ phone: '+91 98201 2345' }).success).toBe(false);
    expect(hire({ phone: '+91 98201 23456' }).success).toBe(true);
    expect(updateEmployeeInput.safeParse({ phone: '12345' }).success).toBe(false);
    expect(updateEmployeeInput.safeParse({ phone: null }).success).toBe(true);
    const company = { name: 'Acme', industry: 'other', companySize: '1-10', countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', fiscalYearStartMonth: 4 };
    expect(setupCompanyInput.safeParse({ ...company, contactPhone: 'call me' }).success).toBe(false);
    expect(setupCompanyInput.safeParse({ ...company, contactPhone: '+91 20 5555 0100' }).success).toBe(true);
    expect(signatureOptionsInput.safeParse({ phone: '', mobile: '+91 98200 11111' }).success).toBe(true);
    expect(signatureOptionsInput.safeParse({ mobile: '98200' }).success).toBe(false);
  });
});

describe('date of birth and joining date', () => {
  it('works out ages and calendar limits from the joining date', () => {
    expect(ageOn('2000-11-18', '2026-11-18')).toBe(26);
    expect(ageOn('2000-11-19', '2026-11-18')).toBe(25);
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(dateOfBirthRange('2026-11-18')).toEqual({ min: '1926-11-18', max: '2012-11-18' });
    expect(earliestJoining('2010-05-01')).toBe('2024-05-01');
  });

  it('rejects a date of birth that does not fit the joining date', () => {
    expect(dateOfBirthError('2026-12-01', '2026-11-18')).toMatch(/before the joining date/);
    expect(dateOfBirthError('2013-01-01', '2026-11-18')).toMatch(/would be 13 on the joining date/);
    expect(dateOfBirthError('1920-01-01', '2026-11-18')).toMatch(/Check the year/);
    expect(dateOfBirthError('1995-04-12', '2026-11-18')).toBeNull();
    expect(issues(hire({ dateOfBirth: '2013-01-01' })).dateOfBirth).toMatch(/at least 14/);
  });

  it('needs HR to confirm a minor', () => {
    expect(isMinorOn('2010-01-01', '2026-11-18')).toBe(true);
    expect(isMinorOn('2008-11-18', '2026-11-18')).toBe(false);
    expect(issues(hire({ dateOfBirth: '2010-01-01' })).minorConfirmed).toMatch(/under 18/);
    expect(hire({ dateOfBirth: '2010-01-01', minorConfirmed: true }).success).toBe(true);
  });
});

describe('work email', () => {
  it('cannot be the personal email', () => {
    expect(issues(hire({ workEmail: 'asha@gmail.com', personalEmail: 'Asha@gmail.com' })).workEmail).toMatch(/not their personal email/);
    expect(hire({ workEmail: 'asha@acme.com', personalEmail: 'asha@gmail.com' }).success).toBe(true);
  });
});

describe('designations', () => {
  it('offers a long list of titles, any of which can be typed instead', () => {
    const all = designationLibrary();
    expect(all.length).toBeGreaterThan(150);
    expect(new Set(all.map((x) => x.name.toLowerCase())).size).toBe(all.length);
    expect(catalogueDesignation('  software   engineer ')).toMatchObject({ name: 'Software Engineer', code: 'SWE' });
    expect(catalogueDesignation('Chief Happiness Officer')).toBeUndefined();
    expect(hire({ designationName: 'Chief Happiness Officer' }).success).toBe(true);
    expect(issues(hire({ designationName: 'Manager', designationId: ENTITY })).designationName).toMatch(/not both/);
  });

  it('setup still ticks a short list per industry, with no code used twice', () => {
    for (const i of INDUSTRIES) {
      const list = suggestedDesignations(i);
      expect(list.length).toBeLessThanOrEqual(40);
      const codes = list.map((x) => x.code);
      expect(new Set(codes).size, `${i}: ${codes.join(',')}`).toBe(codes.length);
    }
  });
});

describe('existing employees', () => {
  it('may keep their code, confirmation date and leave balances', () => {
    const r = hire({ joinedAs: 'existing', dateOfJoining: '2019-04-01', employeeCode: 'ACME/0042', confirmationDate: '2019-10-01', openingLeaveBalances: [{ leaveTypeId: LEAVE, days: 7.5 }] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.openingLeaveBalances).toEqual([{ leaveTypeId: LEAVE, days: '7.5' }]);
  });

  it('keeps those fields to existing employees, with sensible values', () => {
    // Since issue #83 a new joiner may start with leave days too (asked at registration); the confirmation date stays for existing employees.
    expect(hire({ openingLeaveBalances: [{ leaveTypeId: LEAVE, days: 3 }] }).success).toBe(true);
    expect(issues(hire({ confirmationDate: '2019-10-01' })).joinedAs).toMatch(/existing employees/);
    expect(issues(hire({ joinedAs: 'existing', dateOfJoining: '2019-04-01', confirmationDate: '2019-01-01' })).confirmationDate).toMatch(/before the joining date/);
    expect(issues(hire({ joinedAs: 'existing', dateOfJoining: '2019-04-01', openingLeaveBalances: [{ leaveTypeId: LEAVE, days: 1 }, { leaveTypeId: LEAVE, days: 2 }] })).openingLeaveBalances).toMatch(/one opening balance/);
    expect(hire({ joinedAs: 'existing', dateOfJoining: '2019-04-01', employeeCode: 'has space' }).success).toBe(false);
    expect(hire({}).success && hire({}).data?.joinedAs).toBe('new_joiner');
  });
});
