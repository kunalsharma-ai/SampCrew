import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config/config';

export interface AccessClaims {
  sub: string; // user id
  tid: string; // tenant id
  mid: string; // membership id
  sid: string; // session id
  mfa: boolean;
}

export interface PlatformClaims {
  sub: string; // platform admin id
  role: string;
  sid: string;
  mfa: boolean;
}

/** Short-lived purpose tokens used between login steps (MFA challenge, tenant picker). */
export interface StepClaims {
  sub: string;
  purpose: 'mfa' | 'select_tenant' | 'platform_mfa' | 'password_change';
  tenantSlug?: string;
  client?: string;
  mfa?: boolean;
}

const ISSUER = 'crew';

@Injectable()
export class TokenService {
  private readonly accessKey: Uint8Array;
  private readonly platformKey: Uint8Array;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.accessKey = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
    this.platformKey = new TextEncoder().encode(config.JWT_PLATFORM_SECRET);
  }

  get accessTtl() {
    return this.config.ACCESS_TOKEN_TTL_SECONDS;
  }

  signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ tid: claims.tid, mid: claims.mid, sid: claims.sid, mfa: claims.mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience('crew-api')
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtl}s`)
      .sign(this.accessKey);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.accessKey, { issuer: ISSUER, audience: 'crew-api', algorithms: ['HS256'] });
    return { sub: payload.sub!, tid: payload.tid as string, mid: payload.mid as string, sid: payload.sid as string, mfa: payload.mfa === true };
  }

  signPlatform(claims: PlatformClaims): Promise<string> {
    return new SignJWT({ role: claims.role, sid: claims.sid, mfa: claims.mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience('crew-console')
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtl}s`)
      .sign(this.platformKey);
  }

  async verifyPlatform(token: string): Promise<PlatformClaims> {
    const { payload } = await jwtVerify(token, this.platformKey, { issuer: ISSUER, audience: 'crew-console', algorithms: ['HS256'] });
    return { sub: payload.sub!, role: payload.role as string, sid: payload.sid as string, mfa: payload.mfa === true };
  }

  signStep(claims: StepClaims): Promise<string> {
    const key = claims.purpose === 'platform_mfa' ? this.platformKey : this.accessKey;
    return new SignJWT({ purpose: claims.purpose, tenantSlug: claims.tenantSlug, client: claims.client, mfa: claims.mfa === true })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience('crew-step')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }

  async verifyStep(token: string, purpose: StepClaims['purpose']): Promise<StepClaims> {
    const key = purpose === 'platform_mfa' ? this.platformKey : this.accessKey;
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: 'crew-step', algorithms: ['HS256'] });
    if (payload.purpose !== purpose) throw new Error('wrong purpose');
    return { sub: payload.sub!, purpose, tenantSlug: payload.tenantSlug as string | undefined, client: payload.client as string | undefined, mfa: payload.mfa === true };
  }
}
