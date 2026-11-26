import { Badge, Card, CardBody, CardHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { clock } from '@/lib/time';
import type { WorkModeLabels } from '@/lib/types';
import { HoursSplit, ModeBadge, modeLabel } from './parts';
import { VerifyButton } from '@/app/(app)/attendance/work-mode/register/verify-dialog';

export interface WorkModeDay {
  employee: { id: string; name: string; code: string; timeZone: string };
  date: string;
  labels: WorkModeLabels;
  classification: {
    state: string | null; auto: string | null; guess: string | null; provisional: boolean; officeMinutes: number; remoteMinutes: number; unverifiedMinutes: number; workedMinutes: number;
    places: string[]; issues: string[]; explanation: string[]; override: { mode: string; reason: string; byName: string | null; source: string } | null; status: string;
  } | null;
  punches: { id: string; at: string; direction: string; source: string; zone: string; place: string | null; verification: string | null; distanceM: number | null; location: { latitude: number; longitude: number; accuracyM: number | null } | null; locationRemoved: boolean }[];
  checkpoints: { at: string; zone: string; place: string | null; verification: string; location: { latitude: number; longitude: number; accuracyM: number | null } | null }[];
  changes: { at: string; from: string | null; to: string | null; by: string; byName: string | null; reason: string | null }[];
  canVerify: boolean;
}
const ZONE: Record<string, [string, 'accent' | 'success' | 'warning' | 'neutral']> = { office: ['Office', 'accent'], remote: ['Away from office', 'success'], unverified: ['Not verified', 'warning'], neutral: ['Correction', 'neutral'] };
const VERIFY: Record<string, string> = { verified: 'Verified', denied: 'Location refused', unavailable: 'No location', poor_accuracy: 'Too vague', mock_location: 'Mock location', device: 'Device or kiosk' };
const BY: Record<string, string> = { system: 'Automatic', hr: 'HR', correction: 'Approved correction' };

/** The office / home / hybrid part of one day: the result, why, where each punch was, and every change. */
export function WorkModeDayPanel({ d }: { d: WorkModeDay }) {
  const c = d.classification;
  const tz = d.employee.timeZone;
  const L = d.labels;
  return (
    <Card data-testid="work-mode-day">
      <CardHeader title="Office, home or hybrid" description={c?.override ? `Corrected by ${c.override.byName ?? (c.override.source === 'correction' ? 'an approved correction' : 'HR')}: ${c.override.reason}` : 'Worked out from where each check-in and check-out was.'}
        action={<div className="flex items-center gap-2"><ModeBadge mode={c?.state} labels={L} provisional={c?.provisional} corrected={Boolean(c?.override)} />{d.canVerify && c?.state && <VerifyButton row={{ employeeId: d.employee.id, name: d.employee.name, date: d.date, mode: c.state, corrected: c.override }} labels={L} />}</div>} />
      <CardBody className="grid gap-5">
        {c ? (
          <>
            <HoursSplit office={c.officeMinutes} remote={c.remoteMinutes} unverified={c.unverifiedMinutes} labels={L} />
            {c.explanation.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">{c.explanation.map((x, i) => <li key={i}>{x}</li>)}</ul>}
            {c.state === 'pending_verification' && c.guess && <p className="text-[0.8125rem] text-fg-muted">From the verified readings it looks like <strong className="text-fg">{modeLabel(c.guess, L)}</strong>.</p>}
          </>
        ) : <p className="text-sm text-fg-muted">This day has not been classified.</p>}
        {d.punches.length > 0 && (
          <Table>
            <THead><TR><TH>Time</TH><TH>Type</TH><TH>Where</TH><TH>Check</TH><TH>Position</TH></TR></THead>
            <TBody>
              {[...d.punches.map((p) => ({ ...p, kind: p.direction === 'in' ? 'Check-in' : p.direction === 'out' ? 'Check-out' : 'Punch' })),
                ...d.checkpoints.map((p, i) => ({ ...p, id: `cp-${i}`, kind: 'Location update', distanceM: null, locationRemoved: false }))]
                .sort((a, b) => a.at.localeCompare(b.at))
                .map((p) => (
                  <TR key={p.id}>
                    <TD className="tabular">{clock(p.at, tz)}</TD>
                    <TD>{p.kind}</TD>
                    <TD><Badge tone={ZONE[p.zone]?.[1] ?? 'neutral'}>{ZONE[p.zone]?.[0] ?? p.zone}</Badge>{p.place && <span className="ml-1 text-xs text-fg-muted">{p.place}</span>}</TD>
                    <TD className="text-xs text-fg-muted">{p.verification ? VERIFY[p.verification] ?? p.verification : '-'}{p.distanceM !== null && p.zone !== 'office' ? ` · ${p.distanceM} m from the nearest office` : ''}</TD>
                    <TD className="tabular text-xs text-fg-muted">{p.location ? `${p.location.latitude.toFixed(5)}, ${p.location.longitude.toFixed(5)}${p.location.accuracyM ? ` ±${p.location.accuracyM} m` : ''}` : p.locationRemoved ? 'Removed after the retention period' : '-'}</TD>
                  </TR>
                ))}
            </TBody>
          </Table>
        )}
        {d.changes.length > 0 && (
          <div>
            <h3 className="mb-2 text-[0.8125rem] font-semibold text-fg">History</h3>
            <ol className="grid gap-2 border-l border-border pl-4 text-[0.8125rem]" data-testid="work-mode-history">
              {d.changes.map((x, i) => (
                <li key={i} className="relative"><span aria-hidden className="absolute -left-[1.3rem] top-1.5 size-2 rounded-full bg-accent" />
                  <span className="font-medium text-fg">{modeLabel(x.from, L)} → {modeLabel(x.to, L)}</span> <span className="text-fg-muted">· {BY[x.by] ?? x.by}{x.byName ? ` (${x.byName})` : ''} · {new Date(x.at).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })}</span>
                  {x.reason && <div className="text-fg-subtle">{x.reason}</div>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
