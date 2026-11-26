'use client';
import type { OnboardingDocStatus } from '@crew/contracts';
import { Badge, type Tone } from '@crew/ui';
import { Check } from 'lucide-react';

const TONE: Record<OnboardingDocStatus, Tone> = {
  not_assigned: 'neutral', assigned: 'neutral', not_submitted: 'warning', pending_hr_approval: 'info', approved: 'success',
  rejected: 'danger', resubmission_required: 'warning', cancelled: 'neutral',
};

export function OnboardingStatusBadge({ status, label }: { status: OnboardingDocStatus; label: string }) {
  return (
    <Badge tone={TONE[status]} dot={status !== 'approved'} className="whitespace-nowrap">
      {status === 'approved' && <Check className="size-3.5" aria-hidden />}
      {label}
    </Badge>
  );
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="grid gap-1" data-testid="onboarding-progress">
      <div className="h-2 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Onboarding documents approved'}>
        <div className={`h-full transition-all ${p === 100 ? 'bg-success' : 'bg-accent'}`} style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs text-fg-subtle">{p}% {label ?? 'of the mandatory documents approved'}</span>
    </div>
  );
}

