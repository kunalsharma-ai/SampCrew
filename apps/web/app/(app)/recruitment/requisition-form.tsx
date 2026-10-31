import type { FieldDef } from '@/components/resource-form';
import type { Department, LegalEntity, Location, RecruitPerson, Requisition } from '@/lib/types';
import { EMPLOYMENT, opts, WORK_MODE } from './labels';

export interface RequisitionRefs { departments: Department[]; entities: LegalEntity[]; locations: Location[]; people: RecruitPerson[] }

/** Fields for raising or editing a requisition. Once approved, only the wording, scorecard, start date and hiring manager can change. */
export function requisitionFields(refs: RequisitionRefs, approved = false): FieldDef[] {
  const fixed: FieldDef[] = [
    { name: 'departmentId', label: 'Department', type: 'select', required: true, half: true, options: refs.departments.map((d) => ({ value: d.id, label: d.name })) },
    { name: 'legalEntityId', label: 'Legal entity', type: 'select', required: true, half: true, options: refs.entities.map((e) => ({ value: e.id, label: e.name })) },
    { name: 'locationId', label: 'Location', type: 'select', half: true, nullable: true, options: refs.locations.map((l) => ({ value: l.id, label: l.name })) },
    { name: 'employmentType', label: 'Employment type', type: 'select', required: true, half: true, options: opts(EMPLOYMENT) },
    { name: 'workMode', label: 'Work mode', type: 'select', required: true, half: true, options: opts(WORK_MODE) },
    { name: 'headcount', label: 'Openings', type: 'number', required: true, half: true },
    { name: 'currency', label: 'Currency', required: true, half: true, placeholder: 'INR' },
    { name: 'salaryMin', label: 'Budget from (per year)', half: true, nullable: true, placeholder: 'e.g. 1800000' },
    { name: 'salaryMax', label: 'Budget up to (per year)', half: true, nullable: true, placeholder: 'e.g. 2400000' },
    { name: 'justification', label: 'Why this hire is needed', type: 'textarea', hint: 'Seen by approvers only' },
  ];
  return [
    { name: 'title', label: 'Job title', required: true, placeholder: 'e.g. Backend Engineer' },
    { name: 'hiringManagerMembershipId', label: 'Hiring manager', type: 'select', required: true, half: true, options: refs.people.map((p) => ({ value: p.membershipId, label: p.departmentName ? `${p.name} (${p.departmentName})` : p.name })) },
    { name: 'targetStartDate', label: 'Target start date', type: 'date', half: true, nullable: true },
    ...(approved ? [] : fixed),
    { name: 'scorecard', label: 'Interview scorecard', type: 'textarea', required: true, hint: 'One criterion per line. Every interviewer rates each from 1 to 4.' },
    { name: 'description', label: 'Internal job description', type: 'textarea' },
  ];
}

export const requisitionInitial = (r: Requisition) => ({
  ...r, scorecard: r.scorecard.join('\n'),
});
