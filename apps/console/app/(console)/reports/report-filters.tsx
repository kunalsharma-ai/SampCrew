'use client';
import { Button, Field, Input, Select } from '@crew/ui';
import { useRouter } from 'next/navigation';

export function ReportFilters({ kind, filters, clients, money }: { kind: string; filters: Record<string, string>; clients: { id: string; name: string }[]; money: boolean }) {
  const router = useRouter();
  return (
    <form className="flex flex-wrap items-end gap-2" data-testid="report-filters" onSubmit={(e) => {
      e.preventDefault();
      const f = Object.fromEntries([...new FormData(e.currentTarget)].filter(([, v]) => v)) as Record<string, string>;
      router.push(`/reports?${new URLSearchParams({ kind, ...f })}`);
    }}>
      <Field label="From">{(p) => <Input {...p} type="date" name="from" defaultValue={filters.from} />}</Field>
      <Field label="To">{(p) => <Input {...p} type="date" name="to" defaultValue={filters.to} />}</Field>
      {clients.length > 0 && <Field label="Company">{(p) => <Select {...p} name="clientId" defaultValue={filters.clientId ?? ''} className="max-w-[220px]"><option value="">All companies</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>}
      {money && <Field label="Currency">{(p) => <Select {...p} name="currency" defaultValue={filters.currency ?? ''}><option value="">Default</option><option>INR</option><option>USD</option></Select>}</Field>}
      <Button type="submit" variant="secondary">Run report</Button>
    </form>
  );
}
