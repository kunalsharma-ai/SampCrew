import { describe, expect, it } from 'vitest';
import { FEATURE_PARTS, isSwitchableFeature, moduleOfFeature, partForApiPath, partForWebPath } from './feature-parts';
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

  it('cannot name a core module or an unknown key', () => {
    expect(isSwitchableFeature('core_hr')).toBe(true);
    expect(isSwitchableFeature('max_employees')).toBe(false);
    expect(isSwitchableFeature('leave.nothing')).toBe(false);
  });
});
