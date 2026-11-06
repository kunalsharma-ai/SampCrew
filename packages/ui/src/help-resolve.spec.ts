import { describe, expect, it } from 'vitest';
import { allHelpEntries, helpKey, matchRoute, resolveHelp, routeScore, type HelpContent } from './help-resolve';

const content: HelpContent = {
  pages: {
    '/': { title: 'Home', what: 'home' },
    '/employees': { title: 'Employees', what: 'list' },
    '/employees/[id]': { title: 'Employee', what: 'profile' },
    '/employees/new': { title: 'New employee', what: 'new' },
  },
  sections: { Status: { what: 'shared status' }, 'Leave types': { what: 'types' }, 'SampCrew login': { what: 'login' } },
  fields: { Reason: { what: 'shared reason' } },
  modules: { Payroll: { what: 'pay' } },
  routes: {
    '/automation/[id]': { sections: { Status: { what: 'workflow status' } }, fields: { Reason: { what: 'workflow reason' } } },
  },
};

describe('helpKey', () => {
  it('normalises visible text', () => {
    expect(helpKey('  Direct   reports (12) ')).toBe('Direct reports');
    expect(helpKey('CREW login')).toBe('SampCrew login');
    expect(helpKey('Reason *')).toBe('Reason');
  });
});

describe('routes', () => {
  it('matches static and dynamic segments, preferring static ones', () => {
    expect(routeScore('/employees/[id]', '/employees/abc')).toBeGreaterThan(0);
    expect(routeScore('/employees/[id]', '/employees')).toBe(-1);
    expect(routeScore('/employees', '/people')).toBe(-1);
    expect(matchRoute(Object.keys(content.pages), '/employees/new')).toBe('/employees/new');
    expect(matchRoute(Object.keys(content.pages), '/employees/9f1c')).toBe('/employees/[id]');
    expect(matchRoute(Object.keys(content.pages), '/')).toBe('/');
    expect(matchRoute(Object.keys(content.pages), '/employees?view=x#top')).toBe('/employees');
    expect(matchRoute(Object.keys(content.pages), '/nowhere')).toBeUndefined();
  });
});

describe('resolveHelp', () => {
  it('finds pages by route', () => {
    expect(resolveHelp(content, 'page', '/employees/42')?.what).toBe('profile');
    expect(resolveHelp(content, 'page', '/missing')).toBeUndefined();
  });
  it('prefers a route override over the shared entry', () => {
    expect(resolveHelp(content, 'section', '/automation/7', 'Status')?.what).toBe('workflow status');
    expect(resolveHelp(content, 'section', '/settings/devices/7', 'Status')?.what).toBe('shared status');
    expect(resolveHelp(content, 'field', '/automation/7', 'Reason')?.what).toBe('workflow reason');
    expect(resolveHelp(content, 'field', '/leave', 'Reason')?.what).toBe('shared reason');
  });
  it('matches text case-insensitively and with the old brand name', () => {
    expect(resolveHelp(content, 'section', '/x', 'Leave Types')?.what).toBe('types');
    expect(resolveHelp(content, 'section', '/x', 'CREW login')?.what).toBe('login');
  });
  it('returns nothing for unknown or empty text, and does not read inherited keys', () => {
    expect(resolveHelp(content, 'field', '/x', 'Nope')).toBeUndefined();
    expect(resolveHelp(content, 'field', '/x', '')).toBeUndefined();
    expect(resolveHelp(content, 'field', '/x', 'constructor')).toBeUndefined();
    expect(resolveHelp(content, 'module', '/x', 'Payroll')?.what).toBe('pay');
  });
  it('lists every entry', () => {
    expect(allHelpEntries(content)).toHaveLength(4 + 3 + 1 + 1 + 2);
  });
});
