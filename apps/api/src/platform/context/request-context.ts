import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantActor {
  kind: 'user';
  userId: string;
  tenantId: string;
  membershipId: string;
  sessionId: string;
  mfa: boolean;
  label: string;
}

export interface PlatformActor {
  kind: 'platform_admin';
  adminId: string;
  role: string;
  sessionId: string;
  mfa: boolean;
  label: string;
}

export interface RequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  actor?: TenantActor | PlatformActor;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  tenantActor(): TenantActor {
    const a = storage.getStore()?.actor;
    if (!a || a.kind !== 'user') throw new Error('No tenant actor in request context');
    return a;
  },
  platformActor(): PlatformActor {
    const a = storage.getStore()?.actor;
    if (!a || a.kind !== 'platform_admin') throw new Error('No platform actor in request context');
    return a;
  },
  setActor(actor: TenantActor | PlatformActor) {
    const store = storage.getStore();
    if (store) store.actor = actor;
  },
};
