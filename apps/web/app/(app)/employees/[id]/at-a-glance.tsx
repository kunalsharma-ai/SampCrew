import { Badge, Card, CardBody, CardHeader } from '@crew/ui';
import { Award, BookOpen, Briefcase, CalendarDays, Clock, FileText, LifeBuoy, Target, Wallet } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** The Employee 360 summary from GET /employees/:id/360. A null area is hidden by the viewer's access or the plan. */
export interface Summary360 {
  employeeId: string;
  isSelf: boolean;
  joinedOn: string | null;
  tenureDays: number | null;
  attendance: { from: string; to: string; present: number; absent: number; missingPunch: number; onLeave: number; late: number; workingDays: number; avgWorkedMinutes: number; overtimeMinutes: number } | null;
  leave: { pending: number; takenThisYear: string; next: { type: string; startDate: string; endDate: string; days: string } | null } | null;
  pay: { salary: { annualCtc: string; currency: string; effectiveFrom: string } | null; lastPayslip: { periodEnd: string; net: string; currency: string; payDate: string } | null } | null;
  performance: { activeGoals: number; completedGoals: number; atRisk: number; averageProgress: string | null; goals: { title: string; status: string; progress: string; confidence: string | null; periodEnd: string }[]; latestReview: { cycle: string; rating: number | null; releasedAt: string | null } | null } | null;
  learning: { open: number; completed: number; overdue: number; expired: number; recent: { title: string; completedOn: string }[] } | null;
  recognition: { last90Days: number; recent: { from: string; value: string | null; message: string; createdAt: string }[] } | null;
  requests: { open: number; recent: { id: string; number: number; subject: string; status: string; createdAt: string }[] } | null;
  documents: { count: number; categories: string[] } | null;
  timeline: { at: string; kind: string; title: string; detail: string | null; link: string | null }[];
}

const AREAS: [keyof Summary360, string][] = [['attendance', 'Attendance'], ['leave', 'Leave'], ['pay', 'Pay'], ['performance', 'Performance'], ['learning', 'Learning'], ['requests', 'Requests'], ['documents', 'Documents']];

const money = (v: string, currency: string) => {
  const [whole] = v.split('.');
  const grouped = currency === 'INR' ? whole!.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,') : whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}`;
};
const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const date = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const tenure = (days: number) => {
  const y = Math.floor(days / 365);
  const m = Math.floor((days % 365) / 30);
  return y ? `${y} yr${y > 1 ? 's' : ''}${m ? ` ${m} mo` : ''}` : `${m} mo`;
};

function Tile({ icon, label, value, sub, href, tone }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; href?: string; tone?: 'warning' | 'danger' }) {
  const body = (
    <div className="flex h-full flex-col gap-1 rounded-lg border border-border bg-surface p-3.5 transition-colors hover:border-accent/40">
      <span className="flex items-center gap-1.5 text-xs text-fg-subtle">{icon}{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</span>
      {sub && <span className="text-xs text-fg-muted">{sub}</span>}
    </div>
  );
  return href ? <Link href={href} aria-label={label} className="block">{body}</Link> : <div aria-label={label}>{body}</div>;
}

/** A compact strip of figures, one per area the viewer may see. */
export function AtAGlance({ s }: { s: Summary360 }) {
  const id = s.employeeId;
  const a = s.attendance;
  const p = s.performance;
  const hidden = AREAS.filter(([k]) => s[k] === null).map(([, label]) => label);
  return (
    <section aria-label="At a glance" className="mb-6 grid gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {s.tenureDays !== null && <Tile icon={<Briefcase className="size-3.5" />} label="Tenure" value={tenure(s.tenureDays)} sub={s.joinedOn ? `Since ${date(s.joinedOn)}` : undefined} href={`/employees/${id}?tab=job`} />}
        {a && (
          <Tile
            icon={<Clock className="size-3.5" />}
            label="Attendance, 30 days"
            value={a.workingDays ? `${a.present} of ${a.workingDays}` : 'No days yet'}
            sub={[a.late ? `${a.late} late` : null, a.absent ? `${a.absent} absent` : null, a.missingPunch ? `${a.missingPunch} missing punch` : null, a.avgWorkedMinutes ? `avg ${hours(a.avgWorkedMinutes)}` : null].filter(Boolean).join(' · ') || 'Nothing to flag'}
            tone={a.absent + a.missingPunch > 2 ? 'warning' : undefined}
            href={s.isSelf ? '/attendance' : `/attendance/team?employeeId=${id}`}
          />
        )}
        {s.leave && (
          <Tile
            icon={<CalendarDays className="size-3.5" />}
            label="Leave this year"
            value={`${Number(s.leave.takenThisYear)} days`}
            sub={s.leave.next ? `Next: ${s.leave.next.type}, ${date(s.leave.next.startDate)}` : s.leave.pending ? `${s.leave.pending} waiting for approval` : 'None booked'}
            href={`/employees/${id}?tab=leave`}
          />
        )}
        {s.pay && (
          <Tile
            icon={<Wallet className="size-3.5" />}
            label="Pay"
            value={s.pay.salary ? money(s.pay.salary.annualCtc, s.pay.salary.currency) : s.pay.lastPayslip ? money(s.pay.lastPayslip.net, s.pay.lastPayslip.currency) : 'Not set'}
            sub={s.pay.salary ? `A year, from ${date(s.pay.salary.effectiveFrom)}` : s.pay.lastPayslip ? `Net pay for ${date(s.pay.lastPayslip.periodEnd)}` : 'No salary or payslip yet'}
            href={s.pay.salary ? `/payroll/salaries/${id}` : '/payslips'}
          />
        )}
        {p && (
          <Tile
            icon={<Target className="size-3.5" />}
            label="Goals"
            value={p.activeGoals ? `${p.activeGoals} active` : 'None active'}
            sub={[p.averageProgress !== null ? `${p.averageProgress}% average` : null, p.atRisk ? `${p.atRisk} at risk` : null, p.latestReview?.rating ? `Rated ${p.latestReview.rating}/5 in ${p.latestReview.cycle}` : null].filter(Boolean).join(' · ') || `${p.completedGoals} completed`}
            tone={p.atRisk ? 'warning' : undefined}
            href={s.isSelf ? '/goals' : `/goals?view=team&employeeId=${id}`}
          />
        )}
        {s.learning && (
          <Tile
            icon={<BookOpen className="size-3.5" />}
            label="Learning"
            value={`${s.learning.completed} completed`}
            sub={[s.learning.open ? `${s.learning.open} in progress` : null, s.learning.overdue ? `${s.learning.overdue} overdue` : null, s.learning.expired ? `${s.learning.expired} expired` : null].filter(Boolean).join(' · ') || 'Nothing assigned'}
            tone={s.learning.overdue || s.learning.expired ? 'warning' : undefined}
            href="/learning"
          />
        )}
        {s.recognition && <Tile icon={<Award className="size-3.5" />} label="Recognition, 90 days" value={String(s.recognition.last90Days)} sub={s.recognition.recent[0] ? `Latest from ${s.recognition.recent[0].from}` : 'None yet'} href="/recognition" />}
        {s.requests && <Tile icon={<LifeBuoy className="size-3.5" />} label="Open requests" value={String(s.requests.open)} sub={s.requests.recent[0] ? `Latest: ${s.requests.recent[0].subject}` : 'None raised'} href="/helpdesk" />}
        {s.documents && <Tile icon={<FileText className="size-3.5" />} label="Documents" value={String(s.documents.count)} sub={s.documents.categories.map((c) => c.replace(/_/g, ' ')).join(', ') || 'None uploaded'} href={`/employees/${id}?tab=documents`} />}
      </div>
      {hidden.length > 0 && <p className="text-xs text-fg-subtle">Not shown, because your access or the plan does not cover them: {hidden.join(', ')}.</p>}
    </section>
  );
}

const KIND: Record<string, string> = { job: 'Job', leave: 'Leave', goal: 'Goal', learning: 'Learning', recognition: 'Recognition', request: 'Request', document: 'Document' };

/** Everything that happened, newest first, from the areas the viewer may see. */
export function ActivityTab({ s }: { s: Summary360 }) {
  return (
    <Card>
      <CardHeader title="Activity" description="Job changes, leave, goals, learning, recognition, requests and documents, newest first. Only areas your access covers are included." />
      <CardBody>
        {s.timeline.length ? (
          <ol className="relative grid gap-4 border-l border-border pl-5" aria-label="Activity timeline">
            {s.timeline.map((e, i) => (
              <li key={i} className="relative text-[0.8125rem]">
                <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full border-2 border-surface bg-accent" aria-hidden />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{KIND[e.kind] ?? e.kind}</Badge>
                  {e.link ? <Link href={e.link} className="font-medium text-accent hover:underline">{e.title}</Link> : <span className="font-medium">{e.title}</span>}
                  <span className="text-xs text-fg-subtle">{new Date(e.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
                {e.detail && <p className="mt-0.5 text-fg-muted">{e.detail}</p>}
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-fg-muted">Nothing recorded yet.</p>}
      </CardBody>
    </Card>
  );
}
