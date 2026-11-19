import type { Tone } from '@crew/ui';

export const STATUS: Record<string, [string, Tone]> = {
  pending: ['Waiting for review', 'warning'], info_requested: ['Asked for information', 'info'], approved: ['Approved', 'success'], rejected: ['Rejected', 'danger'],
  cancelled: ['Withdrawn', 'neutral'], superseded: ['Replaced', 'neutral'],
};
