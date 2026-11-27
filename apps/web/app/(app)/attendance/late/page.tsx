import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { LateMonth, Me } from '@/lib/types';
import { todayIn } from '@/lib/time';
import { LateMonthView } from './late-view';

export const metadata: Metadata = { title: 'Late coming & penalties' };

const shift = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export default async function LateComingPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month ?? '') ? sp.month! : todayIn((await load<Me>('/me')).tenant.timezone).slice(0, 7);
  const data = await load<LateMonth>(`/attendance/late/month?month=${month}`);
  const label = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  return (
    <>
      <PageHeader
        title="Late coming & penalties"
        description={`${label}. Late arrivals of the people you look after, the reminders they were sent and the deductions payroll will make.`}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link className="hover:underline" href={`?month=${shift(month, -1)}`}>Previous month</Link>
            <Link className="hover:underline" href={`?month=${shift(month, 1)}`}>Next month</Link>
          </div>
        }
      />
      <LateMonthView data={data} />
    </>
  );
}
