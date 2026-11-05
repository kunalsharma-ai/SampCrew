export const KEY_STATUS: Record<string, string> = { active: 'Active', revoked: 'Revoked', expired: 'Expired', owner_inactive: 'Creator no longer active' };
export const DELIVERY_STATUS: Record<string, string> = { pending: 'Waiting to send', sending: 'Sending', succeeded: 'Delivered', failed: 'Failed' };
export const ENDPOINT_STATUS: Record<string, string> = { active: 'On', paused: 'Paused', disabled: 'Switched off' };

export function seconds(s: number) {
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}
export const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : 'Never');
