import { describe, expect, it } from 'vitest';
import { ancestorsOf, FEATURE_ACTION_KEYS, FEATURE_PARTS, featurePart, isFeatureAction, isSwitchableFeature, moduleOfFeature, partForApiPath, partForWebPath } from './feature-parts';
import { BOOLEAN_FEATURES } from './features';

describe('feature parts', () => {
  it('belong to real modules, with unique keys named after their module', () => {
    const modules = new Set(BOOLEAN_FEATURES.map((f) => f.key as string));
    const keys = FEATURE_PARTS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of FEATURE_PARTS) {
      expect(modules.has(p.feature), p.key).toBe(true);
      expect(p.key.startsWith(`${p.feature}.`), p.key).toBe(true);
      expect(moduleOfFeature(p.key)).toBe(p.feature);
      expect(isSwitchableFeature(p.key)).toBe(true);
    }
  });

  it('find the page a path belongs to, the longest match winning', () => {
    expect(partForWebPath('/payroll/salaries/123')?.key).toBe('payroll.salaries');
    expect(partForWebPath('/payroll/runs/9')?.key).toBe('payroll.runs');
    expect(partForWebPath('/settings/signature/company')?.key).toBe('email_signatures.company');
    expect(partForWebPath('/settings/signature')?.key).toBe('email_signatures.mine');
    expect(partForWebPath('/leave?create=leave')?.key).toBe('leave.requests');
    expect(partForWebPath('/insights/universe')?.key).toBe('workforce_universe.universe');
    expect(partForWebPath('/leaves')).toBeUndefined();
    expect(partForWebPath('/')).toBeUndefined();
    expect(partForWebPath('/settings/hr-admin')).toBeUndefined();
  });

  it('find the API routes only one page uses', () => {
    expect(partForApiPath('employees/import/preview')?.key).toBe('core_hr.import');
    expect(partForApiPath('/privacy/requests/1')?.key).toBe('core_hr.privacy');
    expect(partForApiPath('employees')).toBeUndefined();
    expect(partForApiPath('privacy/retention')).toBeUndefined();
  });

  it('buttons sit on a page of their own module, and match their routes by method with an id in the path', () => {
    expect(FEATURE_ACTION_KEYS.length).toBeGreaterThanOrEqual(17);
    for (const key of FEATURE_ACTION_KEYS) {
      const p = featurePart(key)!;
      expect(isFeatureAction(key)).toBe(true);
      expect(p.methods?.length, key).toBeGreaterThan(0);
      if (p.page) {
        expect(featurePart(p.page)?.feature, key).toBe(p.feature);
        expect(isFeatureAction(p.page)).toBe(false);
        // Pages come first, so a page is settled before the buttons on it.
        expect(FEATURE_PARTS.findIndex((x) => x.key === p.page)).toBeLessThan(FEATURE_PARTS.findIndex((x) => x.key === key));
      }
    }
    expect(partForApiPath('payroll/runs/abc/cancel', 'POST')?.key).toBe('payroll.cancel_run');
    expect(partForApiPath('payroll/runs/abc', 'GET')).toBeUndefined();
    expect(partForApiPath('leave/requests/9/cancel', 'POST')?.key).toBe('leave.cancel');
    expect(partForApiPath('leave/requests/9', 'GET')).toBeUndefined();
    expect(partForApiPath('employees/export.csv', 'GET')?.key).toBe('core_hr.people_export');
    expect(partForApiPath('employees/export.csv', 'POST')?.key).not.toBe('core_hr.people_export');
    expect(partForApiPath('announcements/1/publish', 'POST')?.key).toBe('announcements.publish');
    expect(partForApiPath('announcements//publish', 'POST')?.key).not.toBe('announcements.publish');
  });

  it('know what each key sits under', () => {
    expect(ancestorsOf('leave')).toEqual([]);
    expect(ancestorsOf('leave.requests')).toEqual(['leave']);
    expect(ancestorsOf('leave.cancel')).toEqual(['leave', 'leave.requests']);
    expect(ancestorsOf('core_hr.people_export')).toEqual(['core_hr']);
    expect(isFeatureAction('leave.requests')).toBe(false);
  });

  it('cannot name a core module or an unknown key', () => {
    expect(isSwitchableFeature('core_hr')).toBe(true);
    expect(isSwitchableFeature('max_employees')).toBe(false);
    expect(isSwitchableFeature('leave.nothing')).toBe(false);
  });
});
