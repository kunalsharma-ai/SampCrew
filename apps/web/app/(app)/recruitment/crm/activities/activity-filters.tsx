'use client';
import { ACTIVITY_TYPES, CALL_OUTCOMES } from '@crew/contracts';
import { Input, Select } from '@crew/ui';
import { useRouter } from 'next/navigation';
import type { CrmContext } from '../crm-types';

export function ActivityFilters({ ctx, current }: { ctx: CrmContext; current: Record<string, string> }) {
  const router = useRouter();
  const go = (patch: Record<string, string>) => router.push(`/recruitment/crm/activities?${new URLSearchParams(Object.entries({ ...current, ...patch }).filter(([k, v]) => v && k !== 'limit'))}`);
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
      <Select aria-label="Activity type" className="sm:w-48" value={current.type ?? ''} onChange={(e) => go({ type: e.target.value })}>
        <option value="">Any activity</option>{ACTIVITY_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Select>
      <Select aria-label="Call outcome" className="sm:w-48" value={current.outcome ?? ''} onChange={(e) => go({ outcome: e.target.value })}>
        <option value="">Any outcome</option>{CALL_OUTCOMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Select>
      <Select aria-label="Logged by" className="sm:w-48" value={current.by ?? ''} onChange={(e) => go({ by: e.target.value })}>
        <option value="">Anyone</option><option value="me">Me</option>{ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}
      </Select>
      <Input aria-label="From date" type="date" className="sm:w-40" value={current.from ?? ''} onChange={(e) => go({ from: e.target.value })} />
      <Input aria-label="To date" type="date" className="sm:w-40" value={current.to ?? ''} onChange={(e) => go({ to: e.target.value })} />
      <Select aria-label="Include" className="sm:w-56" value={current.include ?? ''} onChange={(e) => go({ include: e.target.value })}>
        <option value="">Logged by people</option><option value="all">Include changes SampCrew recorded</option>
      </Select>
    </div>
  );
}
