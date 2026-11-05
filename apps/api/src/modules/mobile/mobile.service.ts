import { Injectable } from '@nestjs/common';
import type { DeviceRegisterInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';

const COLS = `id, platform, app_version as "appVersion", model, os_version as "osVersion", (push_token is not null) as "pushEnabled",
  registered_at as "registeredAt", last_seen_at as "lastSeenAt", last_sync_at as "lastSyncAt", revoked_at as "revokedAt"`;

/**
 * Phones and tablets signed in to the mobile app. Each device belongs to one workspace membership and is
 * linked to the sign-in that registered it, so signing a device out from the Web Portal also ends that
 * sign-in. Push tokens are kept only while the person allows push.
 */
@Injectable()
export class MobileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async register(input: DeviceRegisterInput) {
    const actor = requestContext.tenantActor();
    const family = await this.db.platform((tx) => one<{ family_id: string }>(tx, 'select family_id from sessions where id = $1', [actor.sessionId]));
    return this.db.tenant(async (tx) => {
      const existing = await one<{ id: string; revoked_at: Date | null }>(tx, 'select id, revoked_at from mobile_devices where membership_id = $1 and installation_id = $2', [actor.membershipId, input.installationId]);
      let id: string;
      if (existing) {
        id = existing.id;
        await tx.query(
          `update mobile_devices set platform = $2, app_version = $3, model = $4, os_version = $5, session_family_id = $6, last_seen_at = now(),
                  revoked_at = null, push_token = case when revoked_at is null then push_token end where id = $1`,
          [id, input.platform, input.appVersion, input.model, input.osVersion, family?.family_id ?? null],
        );
      } else {
        id = (await one<{ id: string }>(
          tx,
          `insert into mobile_devices (tenant_id, membership_id, installation_id, platform, app_version, model, os_version, session_family_id)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
          [actor.membershipId, input.installationId, input.platform, input.appVersion, input.model, input.osVersion, family?.family_id ?? null],
        ))!.id;
      }
      if (!existing || existing.revoked_at) {
        await this.audit.record(tx, { action: 'mobile.device_registered', resourceType: 'mobile_device', resourceId: id, metadata: { platform: input.platform, model: input.model, appVersion: input.appVersion } });
      }
      return one(tx, `select ${COLS} from mobile_devices where id = $1`, [id]);
    });
  }

  async list() {
    const actor = requestContext.tenantActor();
    return this.db.tenant((tx) => many(tx, `select ${COLS} from mobile_devices where membership_id = $1 order by revoked_at nulls first, last_seen_at desc`, [actor.membershipId]));
  }

  async setPushToken(id: string, token: string | null) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const d = await one(tx, 'select id from mobile_devices where id = $1 and membership_id = $2 and revoked_at is null', [id, actor.membershipId]);
      if (!d) throw Errors.notFound('Device');
      // A phone has one token. If someone else signed in on it before, they stop getting pushes here.
      if (token) await tx.query('update mobile_devices set push_token = null, push_token_updated_at = now() where push_token = $1 and id <> $2', [token, id]);
      await tx.query('update mobile_devices set push_token = $2, push_token_updated_at = now(), last_seen_at = now() where id = $1', [id, token]);
      return { pushEnabled: token !== null };
    });
  }

  /** Signs a device out: its sign-in is revoked, its push token removed and its offline queue refused. */
  async revoke(id: string) {
    const actor = requestContext.tenantActor();
    const d = await this.db.tenant(async (tx) => {
      const row = await one<{ session_family_id: string | null }>(tx, 'select session_family_id from mobile_devices where id = $1 and membership_id = $2 and revoked_at is null', [id, actor.membershipId]);
      if (!row) throw Errors.notFound('Device');
      await tx.query('update mobile_devices set revoked_at = now(), push_token = null where id = $1', [id]);
      await this.audit.record(tx, { action: 'mobile.device_signed_out', resourceType: 'mobile_device', resourceId: id });
      return row;
    });
    if (d.session_family_id) {
      await this.db.platform((tx) => tx.query(
        `update sessions set revoked_at = now(), revoked_reason = 'device_signed_out' where family_id = $1 and user_id = $2 and revoked_at is null`,
        [d.session_family_id, actor.userId],
      ));
    }
  }
}
