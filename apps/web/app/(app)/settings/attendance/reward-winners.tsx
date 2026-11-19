import { Badge, buttonClass, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ChevronLeft, ChevronRight, Download, Trophy } from 'lucide-react';
import Link from 'next/link';
import type { RewardWinners } from '@/lib/types';

const shift = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const monthName = (m: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));

/** Who earned each active reward rule in a finished month, with an Excel download, for HR. */
export function RewardWinnersCard({ data, latest }: { data: RewardWinners; latest: string }) {
  const total = data.rules.reduce((n, r) => n + r.winners.length, 0);
  const newer = shift(data.month, 1);
  return (
    <Card>
      <CardHeader
        title="Reward winners"
        description={`Who earned each active reward in ${monthName(data.month)}, worked out from the attendance days of ${data.evaluated} ${data.evaluated === 1 ? 'person' : 'people'}. Only finished months have winners.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link aria-label="Earlier month" className="rounded p-1 hover:bg-bg-subtle" href={`/settings/attendance?winners=${shift(data.month, -1)}`} scroll={false}><ChevronLeft className="size-4" /></Link>
            <span className="min-w-28 text-center text-sm font-medium" data-testid="winners-month">{monthName(data.month)}</span>
            {newer <= latest ? <Link aria-label="Later month" className="rounded p-1 hover:bg-bg-subtle" href={`/settings/attendance?winners=${newer}`} scroll={false}><ChevronRight className="size-4" /></Link> : <span className="size-6" />}
            {total > 0 && <a className={buttonClass('secondary', 'sm')} href={`/rewards-export?month=${data.month}`}><Download className="size-3.5" aria-hidden /> Excel</a>}
          </div>
        }
      />
      {!data.rules.length ? (
        <EmptyState icon={<Trophy className="size-5" />} title="No active rewards" description="Add or switch on a reward above to see its winners here." />
      ) : (
        <div className="grid gap-5 px-5 pb-5" data-testid="reward-winners">
          {data.rules.map((r) => (
            <section key={r.id} aria-label={`${r.name} winners`}>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold">{r.name}</h3>
                <Badge tone={r.winners.length ? 'success' : 'neutral'}>{r.winners.length} earned</Badge>
              </div>
              {r.winners.length ? (
                <Table aria-label={`${r.name} winners`}>
                  <THead><TR><TH>Employee</TH><TH>Department</TH><TH className="text-right">Days counted</TH></TR></THead>
                  <TBody>
                    {r.winners.map((w) => (
                      <TR key={w.employeeId}>
                        <TD><Link className="font-medium hover:underline" href={`/employees/${w.employeeId}`}>{w.name}</Link>{w.code ? <span className="ml-2 text-xs text-fg-subtle">{w.code}</span> : null}</TD>
                        <TD>{w.departmentName ?? '—'}</TD>
                        <TD className="text-right tabular">{w.daysCounted}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : <p className="text-sm text-fg-muted">Nobody earned this one in {monthName(data.month)}.</p>}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
