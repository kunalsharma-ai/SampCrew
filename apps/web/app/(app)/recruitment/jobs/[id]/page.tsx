import type { RequisitionSkills, SkillCatalogueEntry } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { Department, LegalEntity, Location, Pipeline, RecruitPerson, RequisitionDetail } from '@/lib/types';
import { JobSkills } from './job-skills';
import { JobView } from './job-view';

export const metadata: Metadata = { title: 'Job' };

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string }> }) {
  const { id } = await params;
  const { show } = await searchParams;
  const req = await load<RequisitionDetail>(`/recruitment/requisitions/${id}`);
  const status = show === 'rejected' || show === 'withdrawn' ? show : null;
  const [pipeline, departments, entities, locations, people, jobSkills, skillList] = await Promise.all([
    req.can.readCandidates ? loadOptional<Pipeline>(`/recruitment/requisitions/${id}/pipeline${status ? `?status=${status}` : ''}`) : null,
    req.can.edit ? loadOptional<Department[]>('/org/departments') : null,
    req.can.edit ? loadOptional<LegalEntity[]>('/org/legal-entities') : null,
    req.can.edit ? loadOptional<Location[]>('/org/locations') : null,
    loadOptional<RecruitPerson[]>('/recruitment/people'),
    loadOptional<RequisitionSkills>(`/recruitment/requisitions/${id}/skills`),
    loadOptional<{ skills: SkillCatalogueEntry[] }>('/skills'),
  ]);
  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono">{req.code}</span>}
        title={req.title}
        description={`${req.departmentName}${req.locationName ? ` · ${req.locationName}` : ''} · Hiring manager ${req.hiringManagerName}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/recruitment">All jobs</Link>}
      />
      <JobView req={req} pipeline={pipeline} show={status} refs={{ departments: departments ?? [], entities: entities ?? [], locations: locations ?? [], people: people ?? [] }} />
      {jobSkills && <JobSkills requisitionId={id} initial={jobSkills} catalogue={skillList?.skills ?? []} />}
    </>
  );
}
