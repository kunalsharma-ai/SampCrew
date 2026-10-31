import { PLATFORM_ROLE_CAPABILITIES } from '@crew/contracts';
import type { Admin } from './types';

export const hasCap = (me: Pick<Admin, 'role'>, cap: string) => PLATFORM_ROLE_CAPABILITIES[me.role]?.includes(cap) ?? false;
