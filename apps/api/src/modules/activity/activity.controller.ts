import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { sessionLocationInput, type ActivityLog, type SessionLocationInput } from '@crew/contracts';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { AllowWithoutMfa } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const activityQuery = z.object({
  /** Another person's activity (needs audit:read); left out, your own. */
  membershipId: z.uuid().optional(),
  /** How many sign-ins to show, newest first. */
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

/** Audit actions that only describe the session itself, left out of "what was done". */
const SESSION_ACTIONS = new Set(['auth.login', 'auth.logout', 'auth.refresh_reuse_detected']);

/**
 * Activity log (issue #86): every sign-in with when, from which network address (IP), device and GPS position, and
 * what was done in that session, taken from the audit trail. Everyone sees their own; the Super Workspace and HR
 * Workspace people who may read the audit trail can open anyone's.
 */
@Controller()
export class ActivityController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly authz: AuthzService) {}

  @Post('me/session-location')
  @HttpCode(204)
  @AllowWithoutMfa()
  @Doc({ summary: 'Record where you were when you signed in (read once by the browser or app after sign-in), or that the location was not shared', body: sessionLocationInput })
  async location(@Body(new ZodPipe(sessionLocationInput)) body: SessionLocationInput): Promise<void> {
    const actor = requestContext.tenantActor();
    await this.db.platform(async (tx) => {
      const current = await tx.collection('sessions').findOne({ id: actor.sessionId, user_id: actor.userId }, { projection: { family_id: 1 } });
      if (!current) throw Errors.notFound('Session');
      // The sign-in is the family's first row; a later refresh never moves where it signed in from.
      const set = 'status' in body
        ? { location_status: body.status, located_at: new Date() }
        : { latitude: body.latitude, longitude: body.longitude, location_accuracy_m: body.accuracyM === undefined || body.accuracyM === null ? null : Math.round(body.accuracyM), location_status: 'shared', located_at: new Date() };
      await tx.collection('sessions').update({ family_id: current.family_id, located_at: null }, { $set: set });
    });
  }

  @Get('activity')
  @AllowWithoutMfa()
  @Doc({ summary: 'Sign-ins with IP address, device and GPS position, and what was done in each session (yours, or anyone\'s with audit:read)', query: activityQuery })
  async log(@Query(new ZodPipe(activityQuery)) q: z.infer<typeof activityQuery>): Promise<ActivityLog> {
    const actor = requestContext.tenantActor();
    const canViewOthers = hasPermission(await this.authz.subject(), 'audit:read').allowed;
    if (q.membershipId && q.membershipId !== actor.membershipId && !canViewOthers) throw Errors.forbidden('Only people who may read the audit trail can open someone else\'s activity');
    const membershipId = q.membershipId ?? actor.membershipId;
    const { person, people, events } = await this.db.tenant(async (tx) => {
      const m = await tx.collection('memberships').findOne({ id: membershipId }, { projection: { user_id: 1 } });
      if (!m) throw Errors.notFound('Member');
      const users = await tx.users();
      const u = await users.findOne({ id: m.user_id }, { projection: { full_name: 1, email: 1 } });
      let people: ActivityLog['people'] = [];
      if (canViewOthers) {
        const ms = await tx.collection('memberships').find({ status: { $ne: 'suspended' } }, { projection: { user_id: 1 }, limit: 2000 });
        const us = new Map((await users.find({ id: { $in: ms.map((x) => x.user_id) } }, { projection: { full_name: 1 } })).map((x) => [x.id as string, x.full_name as string]));
        people = ms.map((x) => ({ membershipId: x.id as string, name: us.get(x.user_id) ?? 'Unknown' })).sort((a, b) => a.name.localeCompare(b.name));
      }
      if (membershipId !== actor.membershipId) {
        await this.audit.record(tx, { action: 'activity.viewed', resourceType: 'membership', resourceId: membershipId });
      }
      const events = await tx.collection('audit_events').find({ actor_id: m.user_id }, { sort: { created_at: -1 }, limit: 2000, projection: { action: 1, resource_type: 1, resource_id: 1, created_at: 1, ip: 1 } });
      return { person: { membershipId, userId: m.user_id as string, name: (u?.full_name as string) ?? 'Unknown', email: (u?.email as string) ?? '' }, people, events };
    });
    const rows = await this.db.platform((tx) => tx.collection('sessions').find(
      { user_id: person.userId, tenant_id: actor.tenantId },
      { sort: { created_at: -1 }, limit: 600, projection: { id: 1, family_id: 1, client: 1, ip: 1, user_agent: 1, created_at: 1, last_used_at: 1, expires_at: 1, revoked_at: 1, revoked_reason: 1, latitude: 1, longitude: 1, location_accuracy_m: 1, location_status: 1 } },
    ));
    const families = new Map<string, Record<string, any>[]>(); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const r of rows) {
      const key = (r.family_id as string | undefined) ?? (r.id as string);
      families.set(key, [...(families.get(key) ?? []), r]);
    }
    const currentFamily = rows.find((r) => r.id === actor.sessionId)?.family_id as string | undefined;
    const now = Date.now();
    const list = [...families.entries()].slice(0, q.limit);
    const sessions = list.map(([family, group], i) => {
      const latest = group[0]!;
      const first = group[group.length - 1]!;
      const startedAt = new Date(first.created_at as Date);
      const ended = latest.revoked_at && latest.revoked_reason !== 'rotated' ? new Date(latest.revoked_at as Date) : null;
      const lastUsed = new Date((latest.last_used_at as Date | undefined) ?? (latest.created_at as Date));
      // What was done: audit events between this sign-in and the next one (or its end).
      const nextStart = i > 0 ? new Date(list[i - 1]![1].at(-1)!.created_at as Date) : null;
      const until = ended ?? nextStart ?? new Date(now);
      const done = events
        .filter((e) => !SESSION_ACTIONS.has(e.action as string) && new Date(e.created_at as Date) >= startedAt && new Date(e.created_at as Date) <= until)
        .slice(0, 100)
        .map((e) => ({ action: e.action as string, resourceType: (e.resource_type as string | null) ?? null, resourceId: (e.resource_id as string | null) ?? null, at: new Date(e.created_at as Date).toISOString() }));
      const status: 'active' | 'signed_out' | 'expired' = latest.revoked_at ? 'signed_out' : new Date(latest.expires_at as Date).getTime() <= now ? 'expired' : 'active';
      return {
        id: family,
        client: first.client as 'web' | 'mobile' | 'api',
        ip: (first.ip as string | null) ?? null,
        userAgent: (first.user_agent as string | null) ?? null,
        startedAt: startedAt.toISOString(),
        lastActiveAt: lastUsed.toISOString(),
        endedAt: ended?.toISOString() ?? null,
        status,
        current: family === currentFamily,
        location: first.latitude !== null && first.latitude !== undefined
          ? { status: 'shared' as const, latitude: Number(first.latitude), longitude: Number(first.longitude), accuracyM: (first.location_accuracy_m as number | null) ?? null }
          : { status: ((first.location_status as 'denied' | 'unavailable' | undefined) ?? 'not_asked') as 'denied' | 'unavailable' | 'not_asked', latitude: null, longitude: null, accuracyM: null },
        actions: done,
      };
    });
    return { person: { membershipId: person.membershipId, name: person.name, email: person.email }, self: membershipId === actor.membershipId, canViewOthers, people, sessions };
  }
}
