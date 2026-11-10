import { Injectable } from '@nestjs/common';
import type { DeviceRegisterInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deviceView = (d: Record<string, any>) => ({
  id: d.id, platform: d.platform, appVersion: d.app_version, model: d.model ?? null, osVersion: d.os_version ?? null, pushEnabled: d.push_token != null,
  registeredAt: d.registered_at, lastSeenAt: d.last_seen_at ?? null, lastSyncAt: d.last_sync_at ?? null, revokedAt: d.revoked_at ?? null,
});

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
    const family = await this.db.platform((tx) => tx.collection('sessions').findOne({ id: actor.sessionId }, { projection: { family_id: 1 } }));
    return this.db.tenant(async (tx) => {
      const devices = tx.collection('mobile_devices');
      const existing = await devices.findOne({ membership_id: actor.membershipId, installation_id: input.installationId });
      const fields = { platform: input.platform, app_version: input.appVersion, model: input.model, os_version: input.osVersion, session_family_id: (family?.family_id as string | undefined) ?? null };
      let id: string;
      if (existing) {
        id = existing.id as string;
        // A device signed out earlier comes back without its old push token.
        await devices.updateOne({ id }, { $set: { ...fields, last_seen_at: new Date(), revoked_at: null, ...(existing.revoked_at ? { push_token: null } : {}) } });
      } else {
        id = (await devices.insert({ membership_id: actor.membershipId, installation_id: input.installationId, ...fields })).id as string;
      }
      if (!existing || existing.revoked_at) {
        await this.audit.record(tx, { action: 'mobile.device_registered', resourceType: 'mobile_device', resourceId: id, metadata: { platform: input.platform, model: input.model, appVersion: input.appVersion } });
      }
      return deviceView((await devices.findOne({ id }))!);
    });
  }

  async list() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const t = (d: unknown) => (d instanceof Date ? d.getTime() : 0);
      const list = await tx.collection('mobile_devices').find({ membership_id: actor.membershipId });
      // Signed-in devices first (PostgreSQL's "revoked_at nulls first"), each group most recently seen first.
      list.sort((a, b) => (a.revoked_at ? 1 : 0) - (b.revoked_at ? 1 : 0) || t(a.revoked_at) - t(b.revoked_at) || t(b.last_seen_at) - t(a.last_seen_at));
      return list.map(deviceView);
    });
  }

  async setPushToken(id: string, token: string | null) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const devices = tx.collection('mobile_devices');
      if (!(await devices.exists({ id, membership_id: actor.membershipId, revoked_at: null }))) throw Errors.notFound('Device');
      const now = new Date();
      // A phone has one token. If someone else signed in on it before, they stop getting pushes here.
      if (token) await devices.update({ push_token: token, id: { $ne: id } }, { $set: { push_token: null, push_token_updated_at: now } });
      await devices.updateOne({ id }, { $set: { push_token: token, push_token_updated_at: now, last_seen_at: now } });
      return { pushEnabled: token !== null };
    });
  }

  /** Signs a device out: its sign-in is revoked, its push token removed and its offline queue refused. */
  async revoke(id: string) {
    const actor = requestContext.tenantActor();
    const d = await this.db.tenant(async (tx) => {
      const row = await tx.collection('mobile_devices').findOne({ id, membership_id: actor.membershipId, revoked_at: null });
      if (!row) throw Errors.notFound('Device');
      await tx.collection('mobile_devices').updateOne({ id }, { $set: { revoked_at: new Date(), push_token: null } });
      await this.audit.record(tx, { action: 'mobile.device_signed_out', resourceType: 'mobile_device', resourceId: id });
      return row;
    });
    if (d.session_family_id) {
      await this.db.platform((tx) => tx.collection('sessions').update(
        { family_id: d.session_family_id, user_id: actor.userId, revoked_at: null },
        { $set: { revoked_at: new Date(), revoked_reason: 'device_signed_out' } },
      ));
    }
  }
}
