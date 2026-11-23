import { cn } from '@crew/ui';
import type { LeaveAuthorityStatus } from '@/lib/types';

const TONE: Record<string, string> = { approved: 'text-success', rejected: 'text-danger', pending: 'text-warning', waiting: 'text-fg-subtle', cancelled: 'text-fg-subtle' };
const WORD: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', pending: 'Pending', waiting: 'Waits for the step before', cancelled: 'Withdrawn' };

/** Each authority's own decision, so "HR Workspace: Approved · Super Workspace: Pending" reads at a glance. */
export function AuthorityStatus({ authorities, className }: { authorities?: LeaveAuthorityStatus[]; className?: string }) {
  if (!authorities?.length) return null;
  return (
    <ul className={cn('grid gap-0.5 text-xs', className)} data-testid="leave-authorities">
      {authorities.map((a) => (
        <li key={a.authority + a.label}>
          <span className="text-fg-muted">{a.label}:</span> <span className={cn('font-medium', TONE[a.status])}>{WORD[a.status] ?? a.status}</span>
          {a.decidedBy && <span className="text-fg-subtle"> by {a.decidedBy}</span>}
          {a.escalated && a.status === 'pending' && <span className="text-warning"> (escalated)</span>}
        </li>
      ))}
    </ul>
  );
}
