import { ACCRUAL_METHOD_LABELS, LEAVE_EMPLOYMENT_TYPE_LABELS, type AccrualMethod, type LeaveEmploymentType } from '@crew/contracts';
import type { LeaveType } from '@/lib/types';
import type { LeaveOptions } from './pickers';

// Plain text helpers shared by the server pages and the client panels (no 'use client' here, so both can call them).

/** "Name – Super Workspace on 21 Nov 2026 at 14:05" */
export function byLine(who: { name: string | null; level: string | null; at: string | null }, hrWorkspaceName?: string | null) {
  const level = who.level === 'super' ? 'Super Workspace' : who.level === 'hr' ? (hrWorkspaceName ? `HR Workspace (${hrWorkspaceName})` : 'HR Workspace') : who.level === 'system' ? 'SampCrew' : '';
  const when = who.at ? new Date(who.at) : null;
  const at = when ? ` on ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  return `${who.name ?? 'Someone'}${level && who.level !== 'system' ? ` – ${level}` : ''}${at}`;
}

/** One line per rule that is switched on, in plain words. */
export function policyLines(t: Pick<LeaveType, 'policy' | 'allowHalfDay' | 'countsCalendarDays' | 'paid'>): string[] {
  const p = t.policy;
  return [
    `${p.annualEntitlement} days a year · ${ACCRUAL_METHOD_LABELS[p.accrualMethod as AccrualMethod]}`,
    t.paid ? 'Paid' : 'Unpaid',
    t.allowHalfDay ? 'Half days allowed' : 'Full days only',
    t.countsCalendarDays ? 'Counts calendar days' : 'Counts working days',
    p.minDaysPerRequest ? `At least ${p.minDaysPerRequest} days per application` : null,
    p.maxDaysPerRequest ? `At most ${p.maxDaysPerRequest} days per application` : null,
    p.maxConsecutiveDays ? `At most ${p.maxConsecutiveDays} consecutive days` : null,
    p.minNoticeDays ? `${p.minNoticeDays} days’ notice` : null,
    !p.allowMultiDay ? 'One day at a time' : null,
    Number(p.carryForwardMax) > 0 ? `Carry forward up to ${p.carryForwardMax} days${p.carriedExpiryMonths ? `, expiring after ${p.carriedExpiryMonths} months` : ''}` : 'No carry forward',
    !p.availableDuringProbation ? 'Not during probation' : null,
    p.allowNegativeBalance ? 'Balance may go below zero' : null,
    p.documents.mode === 'required' ? `Document required${p.documents.requiredOverDays ? ` above ${p.documents.requiredOverDays} days` : ''}${p.documents.note ? `: ${p.documents.note}` : ''}` : p.documents.mode === 'optional' ? 'Document optional' : null,
  ].filter((x): x is string => !!x);
}

export function eligibilityText(t: LeaveType, options: LeaveOptions) {
  const e = t.eligibility;
  const names = (ids: string[], list: { id: string; name: string }[]) => ids.map((id) => list.find((x) => x.id === id)?.name ?? '?').join(', ');
  const parts = [
    e.employmentTypes.length ? e.employmentTypes.map((k) => LEAVE_EMPLOYMENT_TYPE_LABELS[k as LeaveEmploymentType]).join(', ') : null,
    e.departmentIds.length ? `Departments: ${names(e.departmentIds, options.departments)}` : null,
    e.designationIds.length ? `Designations: ${names(e.designationIds, options.designations)}` : null,
    e.locationIds.length ? `Locations: ${names(e.locationIds, options.locations)}` : null,
    e.legalEntityIds.length ? `Legal entities: ${names(e.legalEntityIds, options.legalEntities)}` : null,
    e.groupIds.length ? `Groups: ${names(e.groupIds, options.groups)}` : null,
    e.employeeIds.length ? `${e.employeeIds.length} named people` : null,
    t.eligibleGender !== 'any' ? (t.eligibleGender === 'female' ? 'Women' : 'Men') : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Everyone';
}

