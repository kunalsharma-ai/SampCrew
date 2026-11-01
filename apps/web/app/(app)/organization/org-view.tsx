'use client';
import { Badge, Button, Card, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Archive, Building2, ChevronRight, Globe2, MapPin, Network, Pencil, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type FieldDef, ResourceDialog } from '@/components/resource-form';
import type { BusinessUnit, Department, LegalEntity, Location } from '@/lib/types';
import { archiveOrgAction, type OrgResource, saveOrgAction } from './actions';

const COUNTRIES = [['IN', 'India'], ['AE', 'United Arab Emirates'], ['GB', 'United Kingdom'], ['US', 'United States'], ['SG', 'Singapore'], ['DE', 'Germany'], ['AU', 'Australia'], ['SA', 'Saudi Arabia'], ['CA', 'Canada'], ['FR', 'France'], ['NL', 'Netherlands'], ['PH', 'Philippines'], ['MY', 'Malaysia'], ['ZA', 'South Africa'], ['KE', 'Kenya'], ['NG', 'Nigeria']].map(([value, label]) => ({ value: value!, label: label! }));
const CURRENCIES = ['INR', 'AED', 'GBP', 'USD', 'SGD', 'EUR', 'AUD', 'SAR', 'CAD', 'PHP', 'MYR', 'ZAR', 'KES', 'NGN'].map((c) => ({ value: c, label: c }));
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Singapore', 'Europe/Berlin', 'Australia/Sydney', 'Asia/Riyadh', 'America/Toronto', 'Europe/Paris', 'Europe/Amsterdam', 'Asia/Manila', 'Asia/Kuala_Lumpur', 'Africa/Johannesburg', 'Africa/Nairobi', 'Africa/Lagos', 'UTC'].map((t) => ({ value: t, label: t }));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => ({ value: String(i + 1), label: m }));
const KINDS = ['office', 'branch', 'factory', 'warehouse', 'store', 'hospital', 'site', 'remote_hub'].map((k) => ({ value: k, label: k.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase()) }));

interface Props {
  tab: OrgResource;
  canManage: boolean;
  entities: LegalEntity[];
  locations: Location[];
  departments: Department[];
  units: BusinessUnit[];
  tree: Department[];
}

export function OrgView(props: Props) {
  const { tab, canManage, entities, locations, departments, units } = props;
  const [editing, setEditing] = useState<{ id: string | null; initial?: Record<string, unknown> } | null>(null);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  const entityOptions = entities.map((e) => ({ value: e.id, label: e.name }));
  const fields: Record<OrgResource, FieldDef[]> = {
    entities: [
      { name: 'name', label: 'Display name', required: true },
      { name: 'legalName', label: 'Registered legal name' },
      { name: 'countryCode', label: 'Country', type: 'select', options: COUNTRIES, required: true, half: true },
      { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES, required: true, half: true },
      { name: 'timezone', label: 'Time zone', type: 'select', options: TIMEZONES, required: true, half: true },
      { name: 'fiscalYearStartMonth', label: 'Fiscal year starts', type: 'select', options: MONTHS, required: true, half: true },
      { name: 'registrationNumber', label: 'Registration number', hint: 'For example CIN or company number', half: true },
      { name: 'taxId', label: 'Tax ID', hint: 'For example GSTIN, VAT or EIN', half: true },
      { name: 'address', label: 'Registered address', type: 'textarea' },
    ],
    locations: [
      { name: 'name', label: 'Name', required: true, half: true },
      { name: 'code', label: 'Code', half: true, placeholder: 'PNQ-1' },
      { name: 'kind', label: 'Type', type: 'select', options: KINDS, required: true, half: true },
      { name: 'legalEntityId', label: 'Legal entity', type: 'select', options: entityOptions, required: true, half: true },
      { name: 'countryCode', label: 'Country', type: 'select', options: COUNTRIES, required: true, half: true },
      { name: 'timezone', label: 'Time zone', type: 'select', options: TIMEZONES, required: true, half: true },
      { name: 'city', label: 'City', half: true },
      { name: 'region', label: 'State / region', half: true },
      { name: 'latitude', label: 'Latitude', type: 'number', step: 'any', half: true, hint: 'Needed for geofenced attendance' },
      { name: 'longitude', label: 'Longitude', type: 'number', step: 'any', half: true },
      { name: 'geofenceRadiusM', label: 'Geofence radius (metres)', type: 'number', hint: '25 to 5,000. Used by mobile attendance from Phase 3.' },
    ],
    departments: [
      { name: 'name', label: 'Name', required: true, half: true },
      { name: 'code', label: 'Code', half: true },
      { name: 'parentId', label: 'Parent department', type: 'select', options: departments.filter((d) => d.id !== editing?.id).map((d) => ({ value: d.id, label: d.name })), nullable: true },
      { name: 'legalEntityId', label: 'Legal entity', type: 'select', options: entityOptions, nullable: true, half: true },
      { name: 'businessUnitId', label: 'Business unit', type: 'select', options: units.map((u) => ({ value: u.id, label: u.name })), nullable: true, half: true },
    ],
    units: [
      { name: 'name', label: 'Name', required: true, half: true },
      { name: 'code', label: 'Code', half: true },
      { name: 'description', label: 'Description', type: 'textarea' },
    ],
  };
  const noun = { entities: 'legal entity', locations: 'location', departments: 'department', units: 'business unit' }[tab];

  const archive = (id: string, name: string) => {
    if (!confirm(`Archive ${name}? It stays in history and reports but can no longer be used.`)) return;
    start(async () => {
      const r = await archiveOrgAction(tab, id);
      setMessage(r.ok ? `${name} archived.` : r.message);
      router.refresh();
    });
  };

  const actions = (id: string, name: string, row: object) =>
    canManage && (
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={() => setEditing({ id, initial: row as Record<string, unknown> })} aria-label={`Edit ${name}`}><Pencil className="size-3.5" /></Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => archive(id, name)} aria-label={`Archive ${name}`}><Archive className="size-3.5" /></Button>
      </div>
    );

  const entityName = (id: string | null) => entities.find((e) => e.id === id)?.name ?? '—';

  let body: React.ReactNode;
  if (tab === 'entities') {
    body = entities.length ? (
      <Table>
        <THead><tr><TH>Entity</TH><TH>Country</TH><TH>Currency</TH><TH>Time zone</TH><TH>Fiscal year</TH><TH /></tr></THead>
        <TBody>
          {entities.map((e) => (
            <TR key={e.id}>
              <TD><div className="font-medium">{e.name}</div>{e.legalName && e.legalName !== e.name && <div className="text-xs text-fg-subtle">{e.legalName}</div>}</TD>
              <TD>{e.countryCode}</TD>
              <TD className="tabular">{e.currency}</TD>
              <TD className="text-fg-muted">{e.timezone}</TD>
              <TD className="text-fg-muted">From {MONTHS[e.fiscalYearStartMonth - 1]?.label}</TD>
              <TD>{actions(e.id, e.name, { ...e, fiscalYearStartMonth: e.fiscalYearStartMonth })}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    ) : <EmptyState icon={<Globe2 className="size-5" />} title="No legal entities" />;
  } else if (tab === 'locations') {
    body = locations.length ? (
      <Table>
        <THead><tr><TH>Location</TH><TH>Type</TH><TH>Entity</TH><TH>Place</TH><TH>Geofence</TH><TH /></tr></THead>
        <TBody>
          {locations.map((l) => (
            <TR key={l.id}>
              <TD><div className="font-medium">{l.name}</div>{l.code && <div className="font-mono text-[0.6875rem] text-fg-subtle">{l.code}</div>}</TD>
              <TD><Badge>{l.kind.replace('_', ' ')}</Badge></TD>
              <TD className="text-fg-muted">{entityName(l.legalEntityId)}</TD>
              <TD className="text-fg-muted">{[l.city, l.region, l.countryCode].filter(Boolean).join(', ')}</TD>
              <TD>{l.geofenceRadiusM ? <Badge tone="success" dot>{l.geofenceRadiusM} m</Badge> : <span className="text-xs text-fg-subtle">Not set</span>}</TD>
              <TD>{actions(l.id, l.name, l)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    ) : <EmptyState icon={<MapPin className="size-5" />} title="No locations yet" description="Add offices, plants, stores or sites. Geofences make mobile attendance possible later." />;
  } else if (tab === 'departments') {
    body = props.tree.length ? (
      <ul className="py-2">{props.tree.map((d) => <DeptNode key={d.id} d={d} depth={0} entityName={entityName} actions={actions} />)}</ul>
    ) : <EmptyState icon={<Network className="size-5" />} title="No departments yet" description="Build your structure top-down. Department managers' permissions follow this tree." />;
  } else {
    body = units.length ? (
      <Table>
        <THead><tr><TH>Business unit</TH><TH>Code</TH><TH>Description</TH><TH /></tr></THead>
        <TBody>
          {units.map((u) => (
            <TR key={u.id}><TD className="font-medium">{u.name}</TD><TD className="font-mono text-xs">{u.code ?? '—'}</TD><TD className="text-fg-muted">{u.description ?? '—'}</TD><TD>{actions(u.id, u.name, u)}</TD></TR>
          ))}
        </TBody>
      </Table>
    ) : <EmptyState icon={<Building2 className="size-5" />} title="No business units" description="Optional. Group departments into divisions such as Operations or Corporate." />;
  }

  return (
    <>
      {message && <div className="mb-4 rounded-md bg-bg-subtle px-4 py-2 text-[0.8125rem] text-fg-muted" role="status">{message}</div>}
      <Card>
        {canManage && (
          <div className="flex justify-end border-b border-border px-5 py-3">
            <Button size="sm" onClick={() => setEditing({ id: null })}><Plus className="size-4" /> Add {noun}</Button>
          </div>
        )}
        {body}
      </Card>
      <ResourceDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${noun}` : `Add ${noun}`}
        fields={fields[tab]}
        initial={editing?.id ? editing.initial : tab === 'entities' ? { fiscalYearStartMonth: '4', countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' } : tab === 'locations' ? { kind: 'office', countryCode: 'IN', timezone: 'Asia/Kolkata', legalEntityId: entities[0]?.id } : undefined}
        submitLabel={editing?.id ? 'Save changes' : `Add ${noun}`}
        onSubmit={(values) => {
          const v = { ...values };
          if (tab === 'entities' && v.fiscalYearStartMonth) v.fiscalYearStartMonth = Number(v.fiscalYearStartMonth);
          // New records should not send nulls.
          if (!editing?.id) for (const k of Object.keys(v)) if (v[k] === null) delete v[k];
          return saveOrgAction(tab, editing?.id ?? null, v);
        }}
      />
    </>
  );
}

function DeptNode({ d, depth, entityName, actions }: { d: Department; depth: number; entityName: (id: string | null) => string; actions: (id: string, name: string, row: object) => React.ReactNode }) {
  return (
    <li>
      <div className="flex items-center gap-3 px-5 py-2.5 hover:bg-bg-subtle/60" style={{ paddingLeft: 20 + depth * 24 }}>
        {depth > 0 ? <ChevronRight className="size-3.5 text-fg-subtle" /> : <Network className="size-4 text-accent" />}
        <div className="min-w-0 flex-1">
          <span className="font-medium">{d.name}</span>
          {d.code && <span className="ml-2 font-mono text-[0.6875rem] text-fg-subtle">{d.code}</span>}
        </div>
        <span className="hidden text-xs text-fg-subtle sm:inline">{entityName(d.legalEntityId)}</span>
        <Badge>{d.memberCount} {d.memberCount === 1 ? 'member' : 'members'}</Badge>
        {actions(d.id, d.name, d)}
      </div>
      {!!d.children?.length && <ul>{d.children.map((c) => <DeptNode key={c.id} d={c} depth={depth + 1} entityName={entityName} actions={actions} />)}</ul>}
    </li>
  );
}
