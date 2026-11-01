import { describe, expect, it } from 'vitest';
import { applyScenario, flowByStage, globeCentre, orthographic, scenarioInput, skillsLayout, skillSummary, type RecruitmentFlow, type SkillsNetwork } from './lenses';

const net: SkillsNetwork = {
  skills: [{ id: 's1', name: 'Forklift', category: null }, { id: 's2', name: 'Welding', category: null }],
  people: [{ id: 'a', name: 'A', departmentId: 'd1' }, { id: 'b', name: 'B', departmentId: 'd1' }, { id: 'c', name: 'C', departmentId: 'd2' }, { id: 'x', name: 'X', departmentId: 'd2' }],
  departments: [],
  links: [{ employeeId: 'a', skillId: 's1', level: 4 }, { employeeId: 'b', skillId: 's1', level: 3 }, { employeeId: 'c', skillId: 's1', level: 3 }, { employeeId: 'c', skillId: 's2', level: 2 }],
};

describe('skills', () => {
  it('summarises holders, experts, departments and risk', () => {
    expect(skillSummary(net)).toEqual([
      { id: 's1', name: 'Forklift', people: 3, experts: 3, departments: 2, risk: 'ok' },
      { id: 's2', name: 'Welding', people: 1, experts: 0, departments: 1, risk: 'single' },
    ]);
  });
  it('lays out people with skills only, inside the ring, the same way every time', () => {
    const l = skillsLayout(net, 600);
    expect(l.people.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    for (const p of l.people) expect(Math.hypot(p.x - 300, p.y - 300)).toBeLessThan(240);
    expect(skillsLayout(net, 600)).toEqual(l);
  });
});

describe('globe', () => {
  it('projects the centre to the middle and hides the far side', () => {
    expect(orthographic(18.5, 73.8, 18.5, 73.8)).toMatchObject({ visible: true });
    expect(Math.abs(orthographic(18.5, 73.8, 18.5, 73.8).x)).toBeLessThan(1e-9);
    expect(orthographic(-18.5, -106.2, 18.5, 73.8).visible).toBe(false);
    // North is up.
    expect(orthographic(40, 73.8, 18.5, 73.8).y).toBeLessThan(0);
  });
  it('centres on the weighted middle of the locations', () => {
    const c = globeCentre([{ lat: 18.5, lng: 73.8, weight: 10 }, { lat: 12.9, lng: 77.6, weight: 10 }]);
    expect(c.lat).toBeGreaterThan(12.9); expect(c.lat).toBeLessThan(18.5);
    expect(c.lng).toBeGreaterThan(73.8); expect(c.lng).toBeLessThan(77.6);
  });
});

describe('recruitment flow', () => {
  it('reads onward moves, rejections, withdrawals and conversion per stage', () => {
    const f: RecruitmentFlow = {
      period: 'all', from: null, to: '2026-11-01', applications: 10,
      stages: [
        { id: 'n', name: 'Applied', kind: 'new', position: 1, reached: 10, now: 3 },
        { id: 's', name: 'Screening', kind: 'screen', position: 2, reached: 5, now: 1 },
        { id: 'h', name: 'Hired', kind: 'hired', position: 5, reached: 1, now: 1 },
      ],
      moves: [{ from: 'n', to: 's', count: 5 }, { from: 'n', to: 'rejected', count: 2 }, { from: 's', to: 'h', count: 1 }, { from: 's', to: 'n', count: 1 }, { from: 's', to: 'withdrawn', count: 2 }],
    };
    const [applied, screen] = flowByStage(f);
    expect(applied).toMatchObject({ reached: 10, onward: 5, rejected: 2, withdrawn: 0, now: 3, conversion: 50 });
    // A move back to an earlier stage is not "onward".
    expect(screen).toMatchObject({ reached: 5, onward: 1, withdrawn: 2, conversion: 20 });
  });
});

describe('scenarios', () => {
  const base = { asOf: '2026-11-01', currency: 'INR', costs: true, departments: [{ id: 'd1', name: 'Ops', headcount: 2, monthlyCost: 70000 }, { id: 'd2', name: 'Sales', headcount: 1, monthlyCost: 50000 }] };
  it('adds people at the stated cost or the department average, and removes them at the average', () => {
    const r = applyScenario(base, [{ departmentId: 'd1', delta: 4, monthlyCostPerHead: 30000 }, { departmentId: 'd2', delta: -1 }]);
    expect(r.rows[0]).toMatchObject({ before: 2, after: 6, costAfter: 190000 });
    expect(r.rows[1]).toMatchObject({ before: 1, after: 0, costAfter: 0 });
    expect(r).toMatchObject({ before: 3, after: 6, costBefore: 120000, costAfter: 190000 });
    expect(applyScenario(base, [{ departmentId: 'd1', delta: 2 }]).rows[0]!.costAfter).toBe(140000);
  });
  it('never goes below zero people and leaves out costs the viewer cannot see', () => {
    const r = applyScenario({ ...base, costs: false, currency: null, departments: base.departments.map((d) => ({ ...d, monthlyCost: null })) }, [{ departmentId: 'd2', delta: -5 }]);
    expect(r.rows[1]).toMatchObject({ after: 0, delta: -1, costAfter: null });
    expect(r.costAfter).toBeNull();
  });
  it('checks the input', () => {
    const d = '00000000-0000-4000-8000-000000000001';
    expect(scenarioInput.safeParse({ name: 'X', changes: [{ departmentId: d, delta: 1 }] }).success).toBe(false);
    expect(scenarioInput.safeParse({ name: 'Plan', changes: [{ departmentId: d, delta: 1 }, { departmentId: d, delta: 2 }] }).success).toBe(false);
    expect(scenarioInput.safeParse({ name: 'Plan', changes: [{ departmentId: d, delta: 1 }] }).success).toBe(true);
  });
});
