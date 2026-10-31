import { describe, expect, it } from 'vitest';
import { FEATURES, PERMISSIONS, PLAN_TEMPLATES, SYSTEM_ROLES, getPermission, signupRequest, password, locationInput } from './index';

describe('permission catalogue', () => {
  it('has unique keys in resource:action format', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z]+(:[a-z]+)+$/);
  });

  it('every system role grant uses a known permission and an allowed scope', () => {
    for (const role of SYSTEM_ROLES) {
      for (const [perm, scope] of Object.entries(role.grants)) {
        const def = getPermission(perm);
        expect(def, `${role.key} grants unknown ${perm}`).toBeDefined();
        expect(def!.scopes as readonly string[], `${role.key}: ${perm} at ${scope}`).toContain(scope);
      }
    }
  });

  it('auditor never receives sensitive or write permissions', () => {
    const auditor = SYSTEM_ROLES.find((r) => r.key === 'auditor')!;
    for (const perm of Object.keys(auditor.grants)) {
      expect(perm.endsWith(':read'), perm).toBe(true);
      expect(getPermission(perm)!.sensitive ?? false).toBe(false);
    }
  });

  it('payroll finalisation is separated from payroll preparation', () => {
    const payrollAdmin = SYSTEM_ROLES.find((r) => r.key === 'payroll_admin')!;
    expect(payrollAdmin.grants['payroll:run']).toBe('tenant');
    expect(payrollAdmin.grants['payroll:approve']).toBeUndefined();
  });

  it('tenant owner holds every permission', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'tenant_owner')!;
    expect(Object.keys(owner.grants).length).toBe(PERMISSIONS.length);
  });
});

describe('plans', () => {
  const featureKeys = new Set(FEATURES.map((f) => f.key));
  it('reference known features and are cumulative', () => {
    let previous = new Set<string>();
    for (const plan of [...PLAN_TEMPLATES].sort((a, b) => a.sortOrder - b.sortOrder)) {
      for (const f of plan.features) expect(featureKeys.has(f)).toBe(true);
      for (const f of previous) expect(plan.features as string[]).toContain(f);
      previous = new Set(plan.features);
    }
  });
});

describe('schemas', () => {
  it('rejects weak passwords', () => {
    expect(password.safeParse('short').success).toBe(false);
    expect(password.safeParse('alllowercaseletters').success).toBe(false);
    expect(password.safeParse('Str0ng-Passphrase').success).toBe(true);
  });

  it('validates signup', () => {
    const ok = signupRequest.safeParse({
      companyName: 'Acme', slug: 'acme', fullName: 'Asha Rao', email: ' Asha@Acme.com ', password: 'Str0ng-Passphrase',
      countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', acceptTerms: true,
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.email).toBe('asha@acme.com');
    const bad = signupRequest.safeParse({ companyName: '', slug: 'Bad Slug', timezone: 'Mars/Base', acceptTerms: false });
    expect(bad.success).toBe(false);
  });

  it('requires coordinates for a geofence', () => {
    const r = locationInput.safeParse({ name: 'Plant', legalEntityId: crypto.randomUUID(), timezone: 'Asia/Kolkata', countryCode: 'IN', geofenceRadiusM: 100 });
    expect(r.success).toBe(false);
  });
});
