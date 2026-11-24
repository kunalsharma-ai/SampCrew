import { load } from '@/lib/api';
import { capsOf, hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import type { ClientDetail } from '../client-types';

/** The signed-in admin and the Company 360 data, shared by every tab. */
export async function loadClient(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [me, c] = await Promise.all([load<Admin>('/platform/auth/me'), load<ClientDetail>(`/platform/clients/${id}`)]);
  return { me, c, caps: capsOf(me), canManage: hasCap(me, 'tenants:manage') };
}
