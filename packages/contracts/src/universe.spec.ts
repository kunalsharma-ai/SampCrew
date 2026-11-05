import { describe, expect, it } from 'vitest';
import { changes, crossLinks, headcount, presentOn, snapshot, timeline, type UniverseData } from './universe';

const u: Pick<UniverseData, 'people' | 'records'> = {
  people: [
    { id: 's', name: 'Sam', code: 'E1', designation: 'Supervisor', joined: '2021-03-01', leftOn: null, status: 'active', departmentId: 'asm', managerId: null, hasLogin: true },
    { id: 'o', name: 'Olu', code: 'E2', designation: 'Operator', joined: '2022-06-01', leftOn: null, status: 'active', departmentId: 'asm', managerId: 's', hasLogin: true },
    { id: 'q', name: 'Quinn', code: 'E3', designation: 'Lead inspector', joined: '2023-01-09', leftOn: null, status: 'active', departmentId: 'asm', managerId: 's', hasLogin: false },
    { id: 'l', name: 'Lee', code: 'E4', designation: 'Operator', joined: '2022-02-01', leftOn: '2024-05-31', status: 'exited', departmentId: 'asm', managerId: 's', hasLogin: false },
  ],
  records: [
    { employeeId: 's', from: '2021-03-01', to: null, departmentId: 'asm', locationId: 'pune', managerId: null, designation: 'Supervisor', reason: 'hire' },
    { employeeId: 'o', from: '2022-06-01', to: null, departmentId: 'asm', locationId: 'pune', managerId: 's', designation: 'Operator', reason: 'hire' },
    { employeeId: 'q', from: '2023-01-09', to: '2023-12-31', departmentId: 'qa', locationId: 'pune', managerId: 's', designation: 'Inspector', reason: 'hire' },
    { employeeId: 'q', from: '2024-01-01', to: '2024-03-31', departmentId: 'asm', locationId: 'pune', managerId: 's', designation: 'Inspector', reason: 'transfer' },
    { employeeId: 'q', from: '2024-04-01', to: null, departmentId: 'asm', locationId: 'pune', managerId: 's', designation: 'Lead inspector', reason: 'promotion' },
    { employeeId: 'l', from: '2022-02-01', to: '2024-05-31', departmentId: 'asm', locationId: 'pune', managerId: 's', designation: 'Operator', reason: 'hire' },
  ],
};

describe('workforce universe model', () => {
  it('knows who is on the books on a date, including the last working day', () => {
    expect(presentOn(u.people[3]!, '2024-05-31')).toBe(true);
    expect(presentOn(u.people[3]!, '2024-06-01')).toBe(false);
    expect(presentOn(u.people[1]!, '2022-05-31')).toBe(false);
  });

  it('rebuilds the organization on any date from the employment records', () => {
    const mid2023 = snapshot(u, '2023-06-30');
    expect(mid2023.map((p) => p.id).sort()).toEqual(['l', 'o', 'q', 's']);
    expect(mid2023.find((p) => p.id === 'q')).toMatchObject({ departmentId: 'qa', designation: 'Inspector' });
    expect(Object.fromEntries(headcount(mid2023))).toEqual({ asm: 3, qa: 1 });
    const now = snapshot(u, '2024-12-31');
    expect(Object.fromEntries(headcount(now))).toEqual({ asm: 3 });
    expect(now.find((p) => p.id === 'q')!.designation).toBe('Lead inspector');
    expect(snapshot(u, '2021-01-01')).toEqual([]);
  });

  it('lists joiners, leavers, moves and promotions between two dates', () => {
    const c = changes(u, '2023-06-30', '2024-12-31');
    expect(c.map((x) => [x.kind, x.name, x.on])).toEqual([
      ['moved', 'Quinn', '2024-01-01'],
      ['promoted', 'Quinn', '2024-04-01'],
      ['left', 'Lee', '2024-05-31'],
    ]);
    expect(c[0]).toMatchObject({ fromDepartmentId: 'qa', toDepartmentId: 'asm' });
    const hires = changes(u, '2000-01-01', '2022-12-31').filter((x) => x.kind === 'joined');
    expect(hires.map((x) => x.name)).toEqual(['Sam', 'Lee', 'Olu']);
  });

  it('counts reporting lines that cross departments', () => {
    expect(crossLinks(snapshot(u, '2023-06-30'))).toEqual([{ a: 'asm', b: 'qa', count: 1 }]);
    expect(crossLinks(snapshot(u, '2024-12-31'))).toEqual([]);
  });

  it('steps through month ends and finishes on the as-of date', () => {
    expect(timeline('2024-01-15', '2024-04-10')).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-10']);
    expect(timeline('2024-04-01', '2024-04-10')).toEqual(['2024-04-10']);
  });
});
