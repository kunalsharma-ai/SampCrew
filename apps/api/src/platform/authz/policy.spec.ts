import { describe, expect, it } from 'vitest';
import { can, effectivePermissions, hasPermission, scopeFilter, scopePredicate, type Grant, type Subject } from './policy';

const tree: Record<string, string[]> = { mfg: ['asm', 'qa'], asm: [], qa: [], hr: [] };
const subtree = (ids: string[]) => {
  const out = new Set<string>();
  const walk = (id: string) => {
    out.add(id);
    (tree[id] ?? []).forEach(walk);
  };
  ids.forEach(walk);
  return out;
};

const subject = (grants: Omit<Grant, 'roleKey' | 'constraints'>[] & Partial<Grant>[], extra: Partial<Subject> = {}): Subject => ({
  userId: 'u1',
  membershipId: 'me',
  legalEntityId: 'in',
  departmentId: 'mfg',
  locationId: 'pune',
  reportIds: new Set(['r1', 'r2']),
  ownDepartmentSubtree: subtree(['mfg']),
  departmentSubtree: subtree,
  grants: grants.map((g) => ({ roleKey: 'test', constraints: {}, ...g }) as Grant),
  mfa: false,
  ...extra,
});

describe('policy engine', () => {
  it('denies without a grant', () => {
    expect(can(subject([]), 'users:read', { membershipId: 'me' })).toEqual({ allowed: false, reason: 'no_grant' });
  });

  it('own scope covers only the subject', () => {
    const s = subject([{ permission: 'users:read', scope: 'own' }]);
    expect(can(s, 'users:read', { membershipId: 'me' }).allowed).toBe(true);
    expect(can(s, 'users:read', { membershipId: 'r1' }).allowed).toBe(false);
  });

  it('team scope covers self and all reports', () => {
    const s = subject([{ permission: 'leave:approve', scope: 'team' }]);
    expect(can(s, 'leave:approve', { membershipId: 'r2' }).allowed).toBe(true);
    expect(can(s, 'leave:approve', { membershipId: 'stranger' })).toEqual({ allowed: false, reason: 'out_of_scope' });
  });

  it('department scope covers the subtree', () => {
    const s = subject([{ permission: 'users:read', scope: 'department' }]);
    expect(can(s, 'users:read', { departmentId: 'asm' }).allowed).toBe(true);
    expect(can(s, 'users:read', { departmentId: 'hr' }).allowed).toBe(false);
  });

  it('entity scope uses the subject entity unless constrained', () => {
    const s = subject([{ permission: 'users:read', scope: 'entity' }]);
    expect(can(s, 'users:read', { legalEntityId: 'in' }).allowed).toBe(true);
    expect(can(s, 'users:read', { legalEntityId: 'uk' }).allowed).toBe(false);
    const c = subject([{ permission: 'users:read', scope: 'entity', constraints: { legalEntityIds: ['uk'] } }]);
    expect(can(c, 'users:read', { legalEntityId: 'uk' }).allowed).toBe(true);
    expect(can(c, 'users:read', { legalEntityId: 'in' }).allowed).toBe(false);
  });

  it('assignment constraints narrow tenant-wide grants', () => {
    const s = subject([{ permission: 'users:read', scope: 'tenant', constraints: { departmentIds: ['mfg'] } }]);
    expect(can(s, 'users:read', { departmentId: 'qa' }).allowed).toBe(true);
    expect(can(s, 'users:read', { departmentId: 'hr' }).allowed).toBe(false);
  });

  it('enforces MFA on permissions that require it', () => {
    const grants = [{ permission: 'roles:manage', scope: 'tenant' as const }];
    expect(hasPermission(subject(grants), 'roles:manage')).toEqual({ allowed: false, reason: 'mfa_required' });
    expect(hasPermission(subject(grants, { mfa: true }), 'roles:manage').allowed).toBe(true);
  });

  it('effective permissions report the widest scope', () => {
    const s = subject([
      { permission: 'users:read', scope: 'own' },
      { permission: 'users:read', scope: 'department' },
    ]);
    expect(effectivePermissions(s)).toEqual({ 'users:read': 'department' });
  });

  it('builds SQL predicates for list filtering', () => {
    const params: unknown[] = [];
    const s = subject([
      { permission: 'users:read', scope: 'own' },
      { permission: 'users:read', scope: 'team' },
    ]);
    const sql = scopePredicate(s, 'users:read', { membershipId: 'm.id', legalEntityId: 'm.le', departmentId: 'm.d', locationId: 'm.l' }, params);
    expect(sql).toBe('((m.id = $1::uuid) or (m.id = any($2::uuid[])))');
    expect(params[1]).toEqual(['me', 'r1', 'r2']);
    expect(scopePredicate(subject([]), 'users:read', { membershipId: 'a', legalEntityId: 'b', departmentId: 'c', locationId: 'd' }, [])).toBeNull();
  });

  describe('scopeFilter (MongoDB)', () => {
    const fields = { membershipId: 'm', legalEntityId: 'le', departmentId: 'd', locationId: 'loc', employeeId: 'e' };
    it('returns null without a grant and an empty filter for tenant scope', () => {
      expect(scopeFilter(subject([]), 'users:read', fields)).toBeNull();
      expect(scopeFilter(subject([{ permission: 'users:read', scope: 'tenant' }, { permission: 'users:read', scope: 'own' }]), 'users:read', fields)).toEqual({});
    });
    it('narrows to the department subtree, team and constraints', () => {
      expect(scopeFilter(subject([{ permission: 'users:read', scope: 'department' }]), 'users:read', fields)).toEqual({ d: { $in: ['mfg', 'asm', 'qa'] } });
      expect(scopeFilter(subject([{ permission: 'users:read', scope: 'team' }]), 'users:read', fields)).toEqual({ m: { $in: ['me', 'r1', 'r2'] } });
      expect(
        scopeFilter(subject([{ permission: 'users:read', scope: 'tenant', constraints: { legalEntityIds: ['in'] } }, { permission: 'users:read', scope: 'own' }], { employeeId: 'emp' }), 'users:read', fields),
      ).toEqual({ $or: [{ le: { $in: ['in'] } }, { $or: [{ m: 'me' }, { e: 'emp' }] }] });
    });
    it('matches nothing for entity scope without an entity', () => {
      expect(scopeFilter(subject([{ permission: 'users:read', scope: 'entity' }], { legalEntityId: null }), 'users:read', fields)).toEqual({ _id: { $in: [] } });
    });
  });
});
