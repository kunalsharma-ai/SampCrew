'use client';
import { useCreateParam } from '@/lib/use-create-param';
import { Alert, Avatar, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Contact, Copy, Search, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Department, Designation, Employee, LegalEntity, Location, OnboardingTemplate, Page } from '@/lib/types';
import { hireAction } from './actions';
import { EmployeeStatus } from './status';

interface Props {
  page: Page<Employee>;
  query: { q: string; status: string; departmentId: string };
  departments: Department[];
  entities: LegalEntity[];
  locations: Location[];
  designations: Designation[];
  managers: Employee[];
  templates: OnboardingTemplate[];
  canHire: boolean;
}

export function EmployeesView(props: Props) {
  const { page, query, departments, canHire } = props;
  const router = useRouter();
  const [hireOpen, setHireOpen] = useCreateParam('employee');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const filter = (patch: Partial<Props['query']>) => {
    const next = { ...query, ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v));
    router.push(`/employees${qs.size ? `?${qs}` : ''}`);
  };
  return (
    <>
      {inviteLink && (
        <Alert tone="info" title="Invitation queued" className="mb-4">
          An invitation email has been queued. If email delivery is not configured in this environment, share this one-time link instead:
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-[0.6875rem] text-fg">{inviteLink}</code>
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(inviteLink)}><Copy className="size-3.5" /> Copy</Button>
          </div>
        </Alert>
      )}
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
          <form className="relative flex-1" onSubmit={(e) => { e.preventDefault(); filter({ q: String(new FormData(e.currentTarget).get('q') ?? '') }); }}>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input name="q" defaultValue={query.q} placeholder="Search by name, employee code or email" className="pl-9" aria-label="Search employees" />
          </form>
          {departments.length > 0 && (
            <Select value={query.departmentId} onChange={(e) => filter({ departmentId: e.target.value })} className="sm:w-48" aria-label="Filter by department">
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          )}
          <Select value={query.status} onChange={(e) => filter({ status: e.target.value })} className="sm:w-40" aria-label="Filter by status">
            <option value="">Current staff</option>
            <option value="pre_boarding">Joining soon</option>
            <option value="probation">On probation</option>
            <option value="active">Confirmed</option>
            <option value="notice">Serving notice</option>
            <option value="exited">Left</option>
          </Select>
          {canHire && <Button onClick={() => setHireOpen(true)}><UserPlus className="size-4" /> Add employee</Button>}
        </div>
        {page.items.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Code</TH><TH>Department</TH><TH>Location</TH><TH>Manager</TH><TH>Joined</TH><TH>Status</TH></tr></THead>
            <TBody>
              {page.items.map((e) => (
                <TR key={e.id} className="cursor-pointer" onClick={() => router.push(`/employees/${e.id}`)}>
                  <TD>
                    <Link href={`/employees/${e.id}`} className="flex items-center gap-3" onClick={(ev) => ev.stopPropagation()}>
                      <Avatar name={e.displayName} size={32} />
                      <span>
                        <span className="block font-medium">{e.displayName}</span>
                        <span className="block text-xs text-fg-subtle">{e.designationName ?? 'No designation'}{e.membershipId ? '' : ' · no CREW login'}</span>
                      </span>
                    </Link>
                  </TD>
                  <TD className="font-mono text-xs text-fg-muted">{e.employeeCode}</TD>
                  <TD className="text-fg-muted">{e.departmentName ?? '—'}</TD>
                  <TD className="text-fg-muted">{e.locationName ?? '—'}</TD>
                  <TD className="text-fg-muted">{e.managerName ?? '—'}</TD>
                  <TD className="whitespace-nowrap text-fg-muted">{e.dateOfJoining}</TD>
                  <TD><EmployeeStatus status={e.status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<Contact className="size-5" />} title={query.q || query.status || query.departmentId ? 'No one matches these filters' : 'No employee records yet'} description={canHire ? 'Add employees one by one. Bulk import arrives with the data migration tools.' : undefined} />
        )}
        {page.nextCursor && (
          <div className="flex justify-center border-t border-border p-3">
            <Link className="text-[0.8125rem] font-medium text-accent hover:underline" href={`/employees?${new URLSearchParams({ ...Object.fromEntries(Object.entries(query).filter(([, v]) => v)), cursor: page.nextCursor })}`}>Next page</Link>
          </div>
        )}
      </Card>
      {canHire && <HireDialog {...props} open={hireOpen} onClose={() => setHireOpen(false)} onInvite={setInviteLink} />}
    </>
  );
}

function HireDialog({ open, onClose, onInvite, entities, departments, locations, designations, managers, templates }: Props & { open: boolean; onClose: () => void; onInvite: (url: string | null) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [entity, setEntity] = useState(entities[0]?.id ?? '');
  const [invite, setInvite] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const defaultTemplate = templates.find((t) => t.isDefault)?.id ?? '';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add employee"
      description="Creates the employee record, their first job record and onboarding checklist. A CREW login is optional."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="hire-form" loading={pending}>Add employee</Button></>}
    >
      <form
        id="hire-form"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const body: Record<string, unknown> = { inviteToCrew: invite, probationMonths: Number(f.get('probationMonths') ?? 6) };
          for (const k of ['firstName', 'lastName', 'workEmail', 'personalEmail', 'phone', 'dateOfJoining', 'legalEntityId', 'departmentId', 'locationId', 'designationId', 'managerEmployeeId', 'employmentType']) {
            const v = String(f.get(k) ?? '').trim();
            if (v) body[k] = v;
          }
          const tpl = String(f.get('onboardingTemplateId') ?? '');
          body.onboardingTemplateId = tpl === 'none' ? null : tpl || undefined;
          setError(null);
          setFe({});
          start(async () => {
            const r = await hireAction(body);
            if (r.ok) {
              onClose();
              // With an invitation link to share, stay here so it can be copied; otherwise open the new profile.
              if (r.data?.inviteUrl) { onInvite(r.data.inviteUrl); router.refresh(); } else router.push(`/employees/${r.data!.employee.id}`);
            } else {
              setError(r.message);
              setFe(r.fieldErrors ?? {});
            }
          });
        }}
      >
        {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
        <Field label="First name" required error={fe.firstName}>{(p) => <Input {...p} name="firstName" required maxLength={80} />}</Field>
        <Field label="Last name" error={fe.lastName}>{(p) => <Input {...p} name="lastName" maxLength={80} />}</Field>
        <Field label="Work email" error={fe.workEmail} hint="Needed to invite them to CREW">{(p) => <Input {...p} name="workEmail" type="email" />}</Field>
        <Field label="Personal email" error={fe.personalEmail}>{(p) => <Input {...p} name="personalEmail" type="email" />}</Field>
        <Field label="Phone" error={fe.phone}>{(p) => <Input {...p} name="phone" type="tel" />}</Field>
        <Field label="Joining date" required error={fe.dateOfJoining}>{(p) => <Input {...p} name="dateOfJoining" type="date" defaultValue={today} required />}</Field>
        <Field label="Legal entity" required error={fe.legalEntityId}>
          {(p) => <Select {...p} name="legalEntityId" value={entity} onChange={(e) => setEntity(e.target.value)}>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        </Field>
        <Field label="Department" error={fe.departmentId}>
          {(p) => <Select {...p} name="departmentId" defaultValue=""><option value="">None</option>{departments.filter((d) => !d.legalEntityId || d.legalEntityId === entity).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
        </Field>
        <Field label="Location" error={fe.locationId}>
          {(p) => <Select {...p} name="locationId" defaultValue=""><option value="">None</option>{locations.filter((l) => l.legalEntityId === entity).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
        </Field>
        <Field label="Designation" error={fe.designationId}>
          {(p) => <Select {...p} name="designationId" defaultValue=""><option value="">None</option>{designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
        </Field>
        <Field label="Reports to" error={fe.managerEmployeeId}>
          {(p) => <Select {...p} name="managerEmployeeId" defaultValue=""><option value="">No manager</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.employeeCode})</option>)}</Select>}
        </Field>
        <Field label="Employment type">
          {(p) => (
            <Select {...p} name="employmentType" defaultValue="full_time">
              <option value="full_time">Full time</option><option value="part_time">Part time</option><option value="contract">Contract</option><option value="intern">Intern</option><option value="temporary">Temporary</option>
            </Select>
          )}
        </Field>
        <Field label="Probation (months)" error={fe.probationMonths} hint="0 confirms them straight away">{(p) => <Input {...p} name="probationMonths" type="number" min={0} max={24} defaultValue={6} />}</Field>
        <Field label="Onboarding checklist">
          {(p) => (
            <Select {...p} name="onboardingTemplateId" defaultValue={defaultTemplate}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>)}
              <option value="none">No checklist</option>
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Checkbox label="Invite them to CREW" description="Sends a sign-in invitation to the work email with Employee self-service access." checked={invite} onChange={(e) => setInvite(e.target.checked)} />
        </div>
      </form>
    </Dialog>
  );
}

