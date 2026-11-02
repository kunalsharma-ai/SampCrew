import { describe, expect, it } from 'vitest';
import {
  applyScimGroupPatch, applyScimPatch, emailDomain, parseScimFilter, parseScimToken, RETENTION_DEFAULTS, retentionPolicyInput, samlSatisfiesMfa, scimEmail, scimFullName,
  ssoConnectionInput, ssoSatisfiesMfa, ssoStartInput,
} from './enterprise';

describe('SCIM helpers', () => {
  it('parses the filters identity providers send', () => {
    expect(parseScimFilter('userName eq "a.b@x.com"')).toEqual({ attr: 'userName', value: 'a.b@x.com' });
    expect(parseScimFilter('externalId eq "00u1\\"q"')).toEqual({ attr: 'externalId', value: '00u1"q' });
    expect(parseScimFilter('USERNAME EQ "x"')).toEqual({ attr: 'userName', value: 'x' });
    expect(parseScimFilter(undefined)).toBeNull();
    expect(parseScimFilter('emails[type eq "work"].value eq "x"')).toBe('unsupported');
    expect(parseScimFilter('userName sw "a"')).toBe('unsupported');
  });
  it('applies Okta and Entra ID style patches', () => {
    const cur = { active: true, givenName: 'Sam', familyName: 'Lee', externalId: null };
    expect(applyScimPatch(cur, [{ op: 'replace', value: { active: false } }]).next.active).toBe(false);
    expect(applyScimPatch(cur, [{ op: 'replace', path: 'active', value: 'False' }]).next.active).toBe(false);
    expect(applyScimPatch(cur, [{ op: 'replace', path: 'name.familyName', value: 'Li' }]).next).toMatchObject({ givenName: 'Sam', familyName: 'Li' });
    const r = applyScimPatch(cur, [{ op: 'add', path: 'phoneNumbers', value: [] }, { op: 'remove', path: 'externalId' }]);
    expect(r.ignored).toEqual(['phoneNumbers']);
  });
  it('finds the sign-in email and name', () => {
    expect(scimEmail({ userName: 'okta-123', emails: [{ value: 'Sam@X.com', primary: true }] })).toBe('sam@x.com');
    expect(scimEmail({ userName: 'not-an-email' })).toBeNull();
    expect(scimFullName({ userName: 'u', name: { givenName: 'Sam', familyName: 'Lee' } })).toBe('Sam Lee');
    expect(scimFullName({ userName: 'u', displayName: 'Sammy' })).toBe('Sammy');
  });
  it('parses tokens', () => {
    expect(parseScimToken(`scim_abcde12345_${'x'.repeat(43)}`)).toMatchObject({ prefix: 'abcde12345' });
    expect(parseScimToken(`crew_abcde12345_${'x'.repeat(43)}`)).toBeNull();
  });
});

describe('single sign-on', () => {
  it('counts only strong methods as two-step verification', () => {
    expect(ssoSatisfiesMfa(['pwd'])).toBe(false);
    expect(ssoSatisfiesMfa(['pwd', 'mfa'])).toBe(true);
    expect(ssoSatisfiesMfa(['hwk'])).toBe(true);
    expect(ssoSatisfiesMfa(undefined)).toBe(false);
  });
  it('validates settings', () => {
    expect(ssoConnectionInput.safeParse({ issuer: 'https://acme.okta.com', clientId: 'x', clientSecret: 's', domains: ['Acme.com'] }).data?.domains).toEqual(['acme.com']);
    expect(ssoConnectionInput.safeParse({ issuer: 'https://acme.okta.com', clientId: 'x', domains: ['@acme.com'] }).success).toBe(false);
    expect(ssoConnectionInput.safeParse({ issuer: 'ftp://acme', clientId: 'x', domains: ['acme.com'] }).success).toBe(false);
    expect(emailDomain('Pat@Sub.Acme.com')).toBe('sub.acme.com');
  });
});

describe('Phase 11 shared rules', () => {
  it('reads group filters and the group patches Okta and Entra ID send', () => {
    expect(parseScimFilter('displayName eq "Payroll team"', ['displayName', 'externalId'])).toEqual({ attr: 'displayName', value: 'Payroll team' });
    expect(parseScimFilter('userName eq "x"', ['displayName', 'externalId'])).toBe('unsupported');
    // Okta: add and remove with value lists; Entra: remove one member by filter path; both: rename.
    const p = applyScimGroupPatch([
      { op: 'add', path: 'members', value: [{ value: 'a' }, { value: 'b' }] },
      { op: 'remove', path: 'members[value eq "c"]' },
      { op: 'Replace', path: 'displayName', value: 'Finance' } as never,
      { op: 'replace', path: 'description', value: 'x' },
    ]);
    expect(p).toMatchObject({ add: ['a', 'b'], remove: ['c'], displayName: 'Finance', ignored: ['description'] });
    expect(applyScimGroupPatch([{ op: 'replace', path: 'members', value: [{ value: 'z' }] }]).replace).toEqual(['z']);
    expect(applyScimGroupPatch([{ op: 'remove', path: 'members' }]).replace).toEqual([]);
    expect(applyScimGroupPatch([{ op: 'add', value: { members: [{ value: 'q' }] } }]).add).toEqual(['q']);
  });
  it('accepts either single sign-on protocol, each with its own fields', () => {
    const base = { domains: ['example.com'], jitProvisioning: false };
    expect(ssoConnectionInput.safeParse({ ...base, issuer: 'https://idp.example', clientId: 'c' }).success).toBe(true);
    expect(ssoConnectionInput.safeParse({ ...base, protocol: 'saml', idpEntityId: 'urn:idp', ssoUrl: 'https://idp.example/sso', certificate: 'M'.repeat(200) }).success).toBe(true);
    expect(ssoConnectionInput.safeParse({ ...base, protocol: 'saml', idpEntityId: 'urn:idp', ssoUrl: 'ftp://idp.example/sso' }).success).toBe(false);
    expect(ssoStartInput.safeParse({ email: 'a@b.co', returnTo: 'crew://sso', appChallenge: 'short' }).success).toBe(false);
  });
  it('counts only real second factors in SAML authentication contexts', () => {
    expect(samlSatisfiesMfa(['urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'])).toBe(false);
    expect(samlSatisfiesMfa(['http://schemas.microsoft.com/claims/multipleauthn'])).toBe(true);
    expect(samlSatisfiesMfa([])).toBe(false);
  });
  it('keeps retention limits sensible', () => {
    expect(retentionPolicyInput.safeParse(RETENTION_DEFAULTS).success).toBe(true);
    expect(retentionPolicyInput.safeParse({ ...RETENTION_DEFAULTS, signInLogDays: 3 }).success).toBe(false);
    expect(retentionPolicyInput.safeParse({ ...RETENTION_DEFAULTS, exitedErasureYears: 0 }).success).toBe(false);
  });
});
