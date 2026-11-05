import { describe, expect, it } from 'vitest';
import { applyScimPatch, emailDomain, parseScimFilter, parseScimToken, scimEmail, scimFullName, ssoConnectionInput, ssoSatisfiesMfa } from './enterprise';

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
