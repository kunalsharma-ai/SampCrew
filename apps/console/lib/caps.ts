import { PLATFORM_ROLE_CAPABILITIES } from '@crew/contracts';
import type { Admin } from './types';

/**
 * Whether the signed-in admin's role has a permission. The API sends the role's current permissions with
 * /platform/auth/me (read from the database on each request), so custom roles work too; the API enforces them again.
 */
export const hasCap = (me: Pick<Admin, 'role'> & { permissions?: readonly string[] }, cap: string) =>
  (me.permissions ?? PLATFORM_ROLE_CAPABILITIES[me.role] ?? []).includes(cap);

/** Every permission the admin has, for components that filter by several. */
export const capsOf = (me: Pick<Admin, 'role'> & { permissions?: readonly string[] }) => [...(me.permissions ?? PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])];
