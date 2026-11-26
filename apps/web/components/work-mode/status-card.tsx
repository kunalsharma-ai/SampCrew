'use client';
import { unverifiedReason } from '@crew/contracts';
import { Alert, Button, cn } from '@crew/ui';
import { Building2, Home, LocateFixed, LogIn, LogOut, MapPin, Repeat, ShieldCheck, ShieldQuestion, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { checkpointAction } from '@/app/(app)/attendance/work-mode-actions';
import { punchAction } from '@/app/(app)/attendance/actions';
import { locateOnce, punchLocation } from '@/lib/locate';
import { clock } from '@/lib/time';
import type { AttendanceToday, WorkModeStateKey } from '@/lib/types';
import { DEFAULT_LABELS, HoursSplit } from './parts';

const THEME: Record<WorkModeStateKey | 'none', { ring: string; glow: string; icon: typeof Building2; chip: string }> = {
  office: { ring: 'from-accent/25 via-accent/5 to-transparent', glow: 'bg-accent', icon: Building2, chip: 'bg-accent text-accent-fg' },
  remote: { ring: 'from-success/25 via-success/5 to-transparent', glow: 'bg-success', icon: Home, chip: 'bg-success text-white' },
  hybrid: { ring: 'from-ember/25 via-ember/5 to-transparent', glow: 'bg-ember', icon: Repeat, chip: 'bg-ember text-white' },
  pending_verification: { ring: 'from-warning/25 via-warning/5 to-transparent', glow: 'bg-warning', icon: ShieldQuestion, chip: 'bg-warning text-white' },
  none: { ring: 'from-bg-subtle via-transparent to-transparent', glow: 'bg-fg-subtle', icon: Sparkles, chip: 'bg-bg-subtle text-fg' },
};

const ZONE_TEXT: Record<string, string> = { office: 'at the office', remote: 'away from the office', unverified: 'location not verified', neutral: 'added by a correction' };

/**
 * The employee's attendance today, front and centre: where today counts (office, home, hybrid or waiting for
 * verification) as a big animated card, the check-in / check-out button, office and away hours, and a location update.
 * The location is read only when the person presses a button here; it is never tracked in the background.
 */
export function WorkModeStatusCard({ today }: { today: AttendanceToday }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger' | 'info'; text: string } | null>(null);
  const wm = today.workMode!;
  const labels = wm.labels ?? DEFAULT_LABELS;
  const tz = today.timeZone;
  const next = today.nextDirection;
  const checkedIn = next === 'out';
  const state = (wm.state ?? (checkedIn ? null : null)) as WorkModeStateKey | null;
  const theme = THEME[state ?? 'none'];
  const Icon = theme.icon;
  const firstIn = today.punches.find((p) => p.direction === 'in');
  const lastOut = [...today.punches].reverse().find((p) => p.direction === 'out');
  const headline = (() => {
    if (state === 'pending_verification') return 'Your location is waiting for verification';
    if (state === 'office' || state === 'remote' || state === 'hybrid') {
      const verb = checkedIn || wm.provisional ? "You're" : 'You were';
      return `${verb} ${labels[state].replace(/^Work From/i, 'Working From')} today`;
    }
    if (today.dayType !== 'working') return today.holidayName ? `Holiday: ${today.holidayName}` : 'Today is a day off';
    return checkedIn ? 'You are checked in' : today.punches.length ? 'You have checked out' : "You haven't checked in yet";
  })();
  const sub = (() => {
    const parts: string[] = [];
    if (firstIn) parts.push(`Checked in at ${clock(firstIn.at, tz)}${wm.places[0] ? ` · ${wm.places[0]}` : ''}`);
    if (lastOut && !checkedIn) parts.push(`checked out at ${clock(lastOut.at, tz)}`);
    if (wm.current && checkedIn) parts.push(`last reading ${ZONE_TEXT[wm.current.zone] ?? wm.current.zone}${wm.current.place ? ` (${wm.current.place})` : ''}`);
    if (!parts.length) return wm.offices.length ? `Check in at ${wm.offices.map((o) => o.name).join(', ')} to count as ${labels.office}; anywhere else counts as ${labels.remote}.` : `Check in to start your day.`;
    return parts.join(', ');
  })();

  const punch = () => start(async () => {
    setNotice(null);
    const { where, refused } = await punchLocation(today);
    if (refused) { setNotice({ tone: 'danger', text: refused }); return; }
    const r = await punchAction({ ...where, direction: next });
    if (!r.ok) { setNotice({ tone: 'danger', text: r.message }); return; }
    const p = r.data!.punch;
    const unverified = p.workZone === 'unverified';
    setNotice({
      tone: unverified ? 'warning' : 'success',
      text: `${p.direction === 'in' ? 'Checked in' : 'Checked out'}${p.workZone === 'office' ? ` at ${p.place ?? 'the office'}` : p.workZone === 'remote' ? ', away from the office' : ''}.${unverified ? ` ${unverifiedReason(where.locationStatus === 'ok' ? 'poor_accuracy' : where.locationStatus === 'denied' ? 'denied' : where.locationStatus ? 'unavailable' : 'no_location', { accuracyM: where.accuracyM ?? null, maxAccuracyM: wm.maxAccuracyM ?? null })} Until then today waits for HR; it is never assumed to be home.` : ''}`,
    });
    window.dispatchEvent(new Event('crew:punched'));
    router.refresh();
  });

  const update = () => start(async () => {
    setNotice(null);
    const where = await locateOnce();
    const r = await checkpointAction(where);
    if (!r.ok) { setNotice({ tone: 'danger', text: r.message }); return; }
    const z = r.data!.zone;
    setNotice({ tone: z.zone === 'unverified' ? 'warning' : 'success', text: z.zone === 'office' ? `Location updated: you are at ${z.place?.name ?? 'the office'}.` : z.zone === 'remote' ? 'Location updated: you are away from the office.' : unverifiedReason(z.verification, { accuracyM: where.accuracyM ?? null, maxAccuracyM: wm.maxAccuracyM ?? null }) });
    router.refresh();
  });

  return (
    <section className="wm-rise relative overflow-hidden rounded-2xl border border-border bg-surface" data-testid="work-mode-status" data-state={state ?? 'none'} aria-labelledby="wm-headline">
      <div aria-hidden className={cn('pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-gradient-to-br blur-2xl', theme.ring)} />
      <div className="relative grid gap-5 p-5 sm:p-6 md:grid-cols-[1fr_auto] md:items-center">
        <div className="flex items-start gap-4">
          <div className="relative grid size-14 shrink-0 place-items-center">
            {checkedIn && <span aria-hidden className={cn('wm-ping absolute inset-0 rounded-2xl opacity-40', theme.glow)} />}
            <span className={cn('relative grid size-14 place-items-center rounded-2xl shadow-sm', theme.chip)}><Icon className="size-7" aria-hidden /></span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Today{wm.provisional ? ' · so far' : ''}{wm.override ? ' · corrected by HR' : ''}</p>
            <h2 id="wm-headline" className="mt-0.5 text-xl font-semibold tracking-tight text-fg sm:text-2xl">{headline}</h2>
            <p className="mt-1 text-[0.8125rem] text-fg-muted">{sub}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {today.allowed.web && today.dayType !== undefined && (
            <Button size="lg" onClick={punch} loading={pending} disabled={today.locked} data-testid="wm-punch" className="min-w-40">
              {next === 'in' ? <LogIn className="size-4" /> : <LogOut className="size-4" />} {next === 'in' ? 'Check in' : 'Check out'}
            </Button>
          )}
          {checkedIn && (
            <Button size="lg" variant="secondary" onClick={update} loading={pending} data-testid="wm-update-location" title="Share where you are now, once">
              <LocateFixed className="size-4" /> Update my location
            </Button>
          )}
        </div>
      </div>
      <div className="relative grid gap-4 border-t border-border px-5 py-4 sm:px-6">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {today.locked && <Alert tone="info">Today is in a period locked for payroll, so checking in is paused. Ask HR if this is unexpected.</Alert>}
        <HoursSplit office={wm.officeMinutes} remote={wm.remoteMinutes} unverified={wm.unverifiedMinutes} labels={labels} />
        {wm.explanation.length > 0 && (
          <details className="text-[0.8125rem] text-fg-muted">
            <summary className="cursor-pointer font-medium text-fg">How today is worked out</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">{wm.explanation.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </details>
        )}
        <p className="flex items-start gap-1.5 text-xs text-fg-subtle">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Your location is read only when you press Check in, Check out or Update my location, never in the background.
          {wm.offices.length > 0 && <span className="inline-flex items-center gap-1"><MapPin className="size-3" aria-hidden /> Your offices: {wm.offices.map((o) => o.name).join(', ')}.</span>}
          {wm.requirement !== 'none' && ` You must ${wm.requirement === 'check_in' ? 'check in' : 'check in and out'} at an office.`}
        </p>
      </div>
    </section>
  );
}
