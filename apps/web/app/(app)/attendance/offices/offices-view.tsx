'use client';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Building2, LocateFixed, MapPin, Plus, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { SwitchRow } from '@/components/work-mode/switch-row';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { GeoMap, type MapCircle } from '@/components/work-mode/geo-map';
import { locateOnce } from '@/lib/locate';
import { archiveSiteAction, createOfficeAction, saveOfficeAction, saveSiteAction, saveWorkAssignmentsAction } from '../work-mode-actions';
import { assignmentsAction } from './assignments-action';

export interface Office { id: string; name: string; kind: string; city: string | null; addressLine: string | null; timezone: string; latitude: number | null; longitude: number | null; radiusM: number | null; active: boolean; configured: boolean; people: number; extraPeople: number }
export interface Site { id: string; name: string; kind: string; addressLine: string | null; latitude: number; longitude: number; radiusM: number; countsAs: 'office' | 'remote'; everyone: boolean; active: boolean; people: number }
export interface PlacesData {
  canEdit: boolean;
  settings: { maxAccuracyM: number; otherOffices: string; officeRequirement: string; enabled: boolean };
  offices: Office[];
  sites: Site[];
  legalEntities: { id: string; name: string; timezone: string; countryCode: string }[];
}

const SITE_KIND: Record<string, string> = { client_site: 'Client site', project_office: 'Temporary project office', coworking: 'Co-working space', other: 'Other approved place' };
const DEFAULT_CENTER = { lat: 20.5937, lon: 78.9629 };

export function OfficesView({ data }: { data: PlacesData }) {
  const [editing, setEditing] = useState<Office | 'new' | null>(null);
  const [site, setSite] = useState<Site | 'new' | null>(null);
  const [assign, setAssign] = useState<{ id: string; name: string; kind: 'office' | 'site' } | null>(null);
  const configured = data.offices.filter((o) => o.configured);
  const circles: MapCircle[] = [
    ...configured.map((o) => ({ lat: o.latitude!, lon: o.longitude!, radiusM: o.radiusM!, tone: o.active ? 'accent' as const : 'muted' as const, label: o.name })),
    ...data.sites.filter((s) => s.active).map((s) => ({ lat: s.latitude, lon: s.longitude, radiusM: s.radiusM, tone: s.countsAs === 'office' ? 'ember' as const : 'success' as const, label: s.name })),
  ];
  const first = configured[0];
  return (
    <div className="grid gap-6" data-testid="offices-view">
      {!data.settings.enabled && <Alert tone="info">Office and home attendance is switched off. Turn it on in the work-mode settings to classify days.</Alert>}
      {configured.length === 0 && <Alert tone="warning" title="No office has a location yet">Until an office has a location and a radius, every check-in counts as away from the office or waits for verification. Set one below.</Alert>}
      <Card>
        <CardHeader title="Map" description="Blue: offices. Orange: approved sites that count as office. Green: approved sites that count as home." />
        <div className="px-5 pb-5">
          <GeoMap center={first ? { lat: first.latitude!, lon: first.longitude! } : DEFAULT_CENTER} zoom={first ? 13 : 4} circles={circles} height={360} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Offices" description="Company locations used as office geofences. People check in at their own work location and any other office they are assigned."
          action={data.canEdit && <Button size="sm" onClick={() => setEditing('new')} data-testid="add-office"><Plus className="size-4" /> Add office</Button>} />
        {data.offices.length === 0 ? <EmptyState icon={<Building2 className="size-5" />} title="No offices yet" description="Add your first office with its address and area." /> : (
          <Table>
            <THead><TR><TH>Office</TH><TH>Location</TH><TH>Area</TH><TH>People</TH><TH>Status</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {data.offices.map((o) => (
                <TR key={o.id} data-testid={`office-${o.id}`}>
                  <TD><div className="font-medium text-fg">{o.name}</div><div className="text-xs text-fg-subtle">{[o.addressLine, o.city].filter(Boolean).join(', ') || o.kind}</div></TD>
                  <TD className="tabular text-xs">{o.configured ? `${o.latitude!.toFixed(5)}, ${o.longitude!.toFixed(5)}` : <span className="text-fg-subtle">Not set</span>}</TD>
                  <TD className="tabular">{o.radiusM ? `${o.radiusM} m` : '-'}</TD>
                  <TD className="tabular">{o.people}{o.extraPeople ? <span className="text-xs text-fg-subtle"> +{o.extraPeople} assigned</span> : null}</TD>
                  <TD>{o.active ? <Badge tone="success" dot>Used for attendance</Badge> : o.configured ? <Badge tone="neutral" dot>Off</Badge> : <Badge tone="warning" dot>No location</Badge>}</TD>
                  <TD className="whitespace-nowrap text-right">
                    {data.canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(o)}><MapPin className="size-4" /> {o.configured ? 'Edit area' : 'Set location'}</Button>}
                    {data.canEdit && <Button size="sm" variant="ghost" onClick={() => setAssign({ id: o.id, name: o.name, kind: 'office' })}><Users className="size-4" /> People</Button>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Approved work sites" description="Client sites, project offices and co-working spaces. Each counts as office or home, for everyone or only the people assigned."
          action={data.canEdit && <Button size="sm" variant="secondary" onClick={() => setSite('new')}><Plus className="size-4" /> Add site</Button>} />
        {data.sites.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">No approved sites. Add one when people regularly work at a client or another approved place.</p> : (
          <Table>
            <THead><TR><TH>Site</TH><TH>Counts as</TH><TH>Who</TH><TH>Area</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {data.sites.map((s) => (
                <TR key={s.id}>
                  <TD><div className="font-medium text-fg">{s.name}</div><div className="text-xs text-fg-subtle">{SITE_KIND[s.kind] ?? s.kind}{s.addressLine ? ` · ${s.addressLine}` : ''}</div></TD>
                  <TD><Badge tone={s.countsAs === 'office' ? 'ember' : 'success'}>{s.countsAs === 'office' ? 'Office' : 'Home / remote'}</Badge>{!s.active && <Badge tone="neutral" className="ml-1">Off</Badge>}</TD>
                  <TD>{s.everyone ? 'Everyone' : `${s.people} assigned`}</TD>
                  <TD className="tabular">{s.radiusM} m</TD>
                  <TD className="whitespace-nowrap text-right">
                    {data.canEdit && <Button size="sm" variant="ghost" onClick={() => setSite(s)}>Edit</Button>}
                    {data.canEdit && !s.everyone && <Button size="sm" variant="ghost" onClick={() => setAssign({ id: s.id, name: s.name, kind: 'site' })}>People</Button>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {editing && <OfficeDialog office={editing === 'new' ? null : editing} entities={data.legalEntities} near={first} onClose={() => setEditing(null)} />}
      {site && <SiteDialog site={site === 'new' ? null : site} near={first} onClose={() => setSite(null)} />}
      {assign && <AssignDialog place={assign} onClose={() => setAssign(null)} />}
    </div>
  );
}

/** Latitude, longitude and radius, set by clicking the map, typing, or the browser's current location. */
function PlaceEditor({ lat, lon, radius, onChange }: { lat: number | null; lon: number | null; radius: number; onChange: (v: { lat: number | null; lon: number | null; radius: number }) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const center = lat !== null && lon !== null ? { lat, lon } : DEFAULT_CENTER;
  return (
    <div className="grid gap-3">
      <GeoMap center={center} zoom={lat !== null ? 16 : 4} height={280} circles={lat !== null && lon !== null ? [{ lat, lon, radiusM: radius }] : []} onPick={(a, b) => onChange({ lat: a, lon: b, radius })} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Latitude">{(f) => <Input {...f} type="number" step="0.000001" min={-90} max={90} value={lat ?? ''} onChange={(e) => onChange({ lat: e.target.value === '' ? null : Number(e.target.value), lon, radius })} required data-testid="place-lat" />}</Field>
        <Field label="Longitude">{(f) => <Input {...f} type="number" step="0.000001" min={-180} max={180} value={lon ?? ''} onChange={(e) => onChange({ lat, lon: e.target.value === '' ? null : Number(e.target.value), radius })} required data-testid="place-lon" />}</Field>
        <Field label="Radius (metres)" hint="25 to 5000">{(f) => <Input {...f} type="number" min={25} max={5000} value={radius} onChange={(e) => onChange({ lat, lon, radius: Number(e.target.value) })} required data-testid="place-radius" />}</Field>
      </div>
      <input type="range" min={25} max={2000} step={25} value={Math.min(2000, radius)} onChange={(e) => onChange({ lat, lon, radius: Number(e.target.value) })} aria-label="Radius" className="w-full accent-[var(--color-accent)]" />
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-fg-muted">
        <Button type="button" size="sm" variant="secondary" loading={busy} onClick={async () => {
          setBusy(true); setErr(null);
          const w = await locateOnce();
          setBusy(false);
          if (w.locationStatus !== 'ok') { setErr('Your browser did not share a location. Click the map or type the coordinates.'); return; }
          onChange({ lat: Number(w.latitude!.toFixed(6)), lon: Number(w.longitude!.toFixed(6)), radius });
        }}><LocateFixed className="size-4" /> Use where I am now</Button>
        <span>Click the map to move the pin.</span>
        {err && <span className="text-danger">{err}</span>}
      </div>
    </div>
  );
}

function OfficeDialog({ office, entities, near, onClose }: { office: Office | null; entities: PlacesData['legalEntities']; near?: Office; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [entity, setEntity] = useState(entities[0]?.id ?? '');
  const [address, setAddress] = useState(office?.addressLine ?? '');
  const [active, setActive] = useState(office ? office.active || !office.configured : true);
  const [v, setV] = useState({ lat: office?.latitude ?? near?.latitude ?? null, lon: office?.longitude ?? near?.longitude ?? null, radius: office?.radiusM ?? 200 });
  const save = () => start(async () => {
    setError(null);
    if (v.lat === null || v.lon === null) { setError('Set the office position on the map or type it.'); return; }
    const r = office
      ? await saveOfficeAction(office.id, { latitude: v.lat, longitude: v.lon, radiusM: v.radius, addressLine: address || null, active })
      : await createOfficeAction({ name, legalEntityId: entity, city: city || null, latitude: v.lat, longitude: v.lon, radiusM: v.radius, addressLine: address || null });
    if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={office ? `Office area: ${office.name}` : 'Add an office'} description="The area is a circle around the office. A check-in inside it counts as office attendance."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={pending} data-testid="save-office">Save</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {!office && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Office name" required>{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} data-testid="office-name" />}</Field>
            <Field label="City">{(f) => <Input {...f} value={city} onChange={(e) => setCity(e.target.value)} maxLength={120} />}</Field>
            <Field label="Legal entity">{(f) => <Select {...f} value={entity} onChange={(e) => setEntity(e.target.value)}>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
          </div>
        )}
        <Field label="Address">{(f) => <Input {...f} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} placeholder="Street, area" />}</Field>
        <PlaceEditor lat={v.lat} lon={v.lon} radius={v.radius} onChange={setV} />
        {office && <SwitchRow checked={active} onChange={setActive} label="Use this office for office / home attendance" />}
      </div>
    </Dialog>
  );
}

function SiteDialog({ site, near, onClose }: { site: Site | null; near?: Office; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ name: site?.name ?? '', kind: site?.kind ?? 'client_site', addressLine: site?.addressLine ?? '', countsAs: site?.countsAs ?? 'office', everyone: site?.everyone ?? false, active: site?.active ?? true });
  const [v, setV] = useState({ lat: site?.latitude ?? near?.latitude ?? null, lon: site?.longitude ?? near?.longitude ?? null, radius: site?.radiusM ?? 150 });
  const save = () => start(async () => {
    setError(null);
    if (v.lat === null || v.lon === null) { setError('Set the site position on the map or type it.'); return; }
    const r = await saveSiteAction(site?.id ?? null, { ...f, addressLine: f.addressLine || null, latitude: v.lat, longitude: v.lon, radiusM: v.radius });
    if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
  });
  const archive = () => start(async () => {
    const r = await archiveSiteAction(site!.id);
    if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={site ? `Approved site: ${site.name}` : 'Add an approved site'} description="A place people may work from that is not one of your offices."
      footer={<>{site && <Button variant="ghost" onClick={archive} loading={pending} className="mr-auto" data-delete={`the approved site ${site.name}`} data-delete-area="attendance">Archive</Button>}<Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={pending}>Save</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={160} />}</Field>
          <Field label="Kind">{(p) => <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(SITE_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="Counts as">{(p) => <Select {...p} value={f.countsAs} onChange={(e) => setF({ ...f, countsAs: e.target.value as 'office' })}><option value="office">Office attendance</option><option value="remote">Home / remote attendance</option></Select>}</Field>
          <Field label="Address">{(p) => <Input {...p} value={f.addressLine} onChange={(e) => setF({ ...f, addressLine: e.target.value })} maxLength={300} />}</Field>
        </div>
        <PlaceEditor lat={v.lat} lon={v.lon} radius={v.radius} onChange={setV} />
        <SwitchRow checked={f.everyone} onChange={(x) => setF({ ...f, everyone: x })} label="Everyone may use this site (otherwise only assigned people)" />
        <SwitchRow checked={f.active} onChange={(x) => setF({ ...f, active: x })} label="In use" />
      </div>
    </Dialog>
  );
}

type Row = { employeeId: string; name: string; code: string; department: string | null; homeLocationId: string | null; homeLocation: string | null; officeIds: string[]; siteIds: string[]; officeRequirement: string | null };

function AssignDialog({ place, onClose }: { place: { id: string; name: string; kind: 'office' | 'site' }; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<Row[]>([]);
  const [find, setFind] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [requirement, setRequirement] = useState<'' | 'none' | 'check_in' | 'check_in_out'>('');
  useEffect(() => {
    void assignmentsAction().then((r) => {
      if (!r.ok) { setError(r.message); return; }
      const list = r.data!.rows as Row[];
      setRows(list);
      setChosen(new Set(list.filter((x) => (place.kind === 'office' ? x.officeIds : x.siteIds).includes(place.id)).map((x) => x.employeeId)));
    });
  }, [place.id, place.kind]);
  const shown = useMemo(() => rows.filter((r) => `${r.name} ${r.code} ${r.department ?? ''}`.toLowerCase().includes(find.toLowerCase())), [rows, find]);
  const save = () => start(async () => {
    setError(null);
    const had = new Set(rows.filter((x) => (place.kind === 'office' ? x.officeIds : x.siteIds).includes(place.id)).map((x) => x.employeeId));
    const add = [...chosen].filter((x) => !had.has(x));
    const remove = [...had].filter((x) => !chosen.has(x));
    const key = place.kind === 'office' ? 'officeIds' : 'siteIds';
    for (const [mode, ids] of [['add', add], ['remove', remove]] as const) {
      for (let i = 0; i < ids.length; i += 500) {
        const r = await saveWorkAssignmentsAction({ employeeIds: ids.slice(i, i + 500), [key]: [place.id], mode, ...(requirement && mode === 'add' ? { officeRequirement: requirement } : {}) });
        if (!r.ok) { setError(r.message); return; }
      }
    }
    onClose();
    router.refresh();
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={`Who may work at ${place.name}`} description={place.kind === 'office' ? 'People always count as office at their own work location. Choose who may also check in here.' : 'Choose who may check in at this site.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={pending}>Save</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Input placeholder="Search by name, employee ID or department" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search people" />
        <div className="flex justify-between text-xs text-fg-subtle"><span>{chosen.size} chosen</span>
          <span className="flex gap-3"><button type="button" className="font-medium text-accent" onClick={() => setChosen(new Set([...chosen, ...shown.map((x) => x.employeeId)]))}>Select all shown</button><button type="button" className="font-medium text-accent" onClick={() => setChosen(new Set())}>Clear</button></span></div>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border p-2">
          {shown.map((r) => (
            <Checkbox key={r.employeeId} label={`${r.name}${r.code ? ` (${r.code})` : ''}`} description={[r.department, r.homeLocation && `works at ${r.homeLocation}`].filter(Boolean).join(' · ') || undefined}
              checked={chosen.has(r.employeeId) || (place.kind === 'office' && r.homeLocationId === place.id)} disabled={place.kind === 'office' && r.homeLocationId === place.id}
              onChange={(e) => { const n = new Set(chosen); if (e.target.checked) n.add(r.employeeId); else n.delete(r.employeeId); setChosen(n); }} />
          ))}
          {!shown.length && <p className="text-xs text-fg-subtle">{rows.length ? 'Nobody matches.' : 'Loading…'}</p>}
        </div>
        <Field label="Office rule for the people added" hint="Leave as is to follow the company setting.">{(p) => (
          <Select {...p} value={requirement} onChange={(e) => setRequirement(e.target.value as typeof requirement)}>
            <option value="">Company setting</option><option value="none">May check in anywhere</option><option value="check_in">Must check in at an office</option><option value="check_in_out">Must check in and out at an office</option>
          </Select>
        )}</Field>
      </div>
    </Dialog>
  );
}
