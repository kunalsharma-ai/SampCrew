import { Badge, type Tone } from '@crew/ui';

const LABEL: Record<string, [string, Tone]> = {
  pre_boarding: ['Joining soon', 'info'],
  probation: ['Probation', 'warning'],
  active: ['Confirmed', 'success'],
  notice: ['Serving notice', 'warning'],
  exited: ['Left', 'neutral'],
};

export function EmployeeStatus({ status }: { status: string }) {
  const [label, tone] = LABEL[status] ?? [status, 'neutral'];
  return <Badge tone={tone} dot>{label}</Badge>;
}
