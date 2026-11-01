import { Injectable } from '@nestjs/common';
import type { AnnouncementInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { nameOf } from '../talent/talent-common';

/** SQL deciding whether the employee aliased `e` is in announcement `a`'s audience. */
const IN_AUDIENCE = `(a.legal_entity_id is null or e.current_legal_entity_id = a.legal_entity_id)
  and (a.location_id is null or e.current_location_id = a.location_id)
  and (a.department_id is null or e.current_department_id in (
        with recursive deps(id) as (select a.department_id union select d.id from departments d join deps on d.parent_id = deps.id) select id from deps))`;

const COLS = `a.id, a.title, a.body, a.legal_entity_id as "legalEntityId", le.name as "legalEntityName", a.department_id as "departmentId", d.name as "departmentName",
  a.location_id as "locationId", l.name as "locationName", a.requires_ack as "requiresAck", a.pinned, a.status, a.published_at as "publishedAt",
  to_char(a.expires_on, 'YYYY-MM-DD') as "expiresOn", a.created_at as "createdAt", a.updated_at as "updatedAt",
  coalesce(nullif(${nameOf('pe')}, ''), pu.full_name) as "publishedByName"`;
const FROM = `announcements a left join legal_entities le on le.id = a.legal_entity_id left join departments d on d.id = a.department_id
  left join locations l on l.id = a.location_id left join memberships pm on pm.id = a.published_by_membership_id
  left join users pu on pu.id = pm.user_id left join employees pe on pe.id = pm.employee_id`;

/**
 * Announcements from HR to everyone or to a legal entity, department (with its sub-departments) or location.
 * Publishing notifies the audience. Once published, the wording and audience are fixed by a database trigger,
 * so an acknowledgement always refers to the text the person saw. Read and acknowledgement times are kept.
 */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async audience(tx: Tx, id: string) {
    return many<{ membership_id: string }>(
      tx,
      `select e.membership_id from announcements a join employees e on ${IN_AUDIENCE}
        join memberships m on m.id = e.membership_id and m.status = 'active'
        where a.id = $1 and e.status in ('active', 'notice', 'probation') and e.membership_id is not null`,
      [id],
    );
  }

  private async checkRefs(tx: Tx, input: AnnouncementInput) {
    if (input.legalEntityId && !(await one(tx, 'select 1 from legal_entities where id = $1', [input.legalEntityId]))) throw Errors.badRequest('unknown_legal_entity', 'Choose an existing legal entity');
    if (input.departmentId && !(await one(tx, 'select 1 from departments where id = $1', [input.departmentId]))) throw Errors.badRequest('unknown_department', 'Choose an existing department');
    if (input.locationId && !(await one(tx, 'select 1 from locations where id = $1', [input.locationId]))) throw Errors.badRequest('unknown_location', 'Choose an existing location');
  }

  /** The caller's feed: published, unexpired announcements addressed to them, pinned first. */
  async feed(limit = 50) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) return [];
      return many(
        tx,
        `select ${COLS}, r.read_at as "readAt", r.acknowledged_at as "acknowledgedAt"
           from ${FROM} join employees e on e.id = $1 and ${IN_AUDIENCE}
           left join announcement_receipts r on r.announcement_id = a.id and r.membership_id = $2
          where a.status = 'published' and (a.expires_on is null or a.expires_on >= current_date)
          order by a.pinned desc, a.published_at desc limit $3`,
        [s.employeeId, s.membershipId, limit],
      );
    });
  }

  /** Opens one announcement from the feed and records the first read. */
  async read(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const manage = hasPermission(s, 'announcements:manage').allowed;
      const a = await one<{ id: string; status: string }>(
        tx,
        `select ${COLS} from ${FROM} where a.id = $1 and (a.status = 'published' and exists (select 1 from employees e where e.id = $2 and ${IN_AUDIENCE}) or $3)`,
        [id, s.employeeId ?? null, manage],
      );
      if (!a) throw Errors.notFound('Announcement');
      let receipt: { readAt: Date; acknowledgedAt: Date | null } | null = null;
      if (a.status === 'published' && s.employeeId && (await one(tx, `select 1 from announcements a join employees e on e.id = $2 and ${IN_AUDIENCE} where a.id = $1`, [id, s.employeeId]))) {
        await tx.query(`insert into announcement_receipts (tenant_id, announcement_id, membership_id) values (app_tenant_id(), $1, $2) on conflict do nothing`, [id, s.membershipId]);
        receipt = (await one<{ readAt: Date; acknowledgedAt: Date | null }>(tx, `select read_at as "readAt", acknowledged_at as "acknowledgedAt" from announcement_receipts where announcement_id = $1 and membership_id = $2`, [id, s.membershipId]))!;
      }
      return { ...a, readAt: receipt?.readAt ?? null, acknowledgedAt: receipt?.acknowledgedAt ?? null, inAudience: receipt !== null, canManage: manage };
    });
  }

  async acknowledge(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const a = await one<{ requires_ack: boolean }>(
        tx, `select a.requires_ack from announcements a join employees e on e.id = $2 and ${IN_AUDIENCE} where a.id = $1 and a.status = 'published'`, [id, s.employeeId ?? null],
      );
      if (!a) throw Errors.notFound('Announcement');
      if (!a.requires_ack) throw Errors.badRequest('no_ack_needed', 'This announcement does not ask for an acknowledgement');
      await tx.query(
        `insert into announcement_receipts (tenant_id, announcement_id, membership_id, acknowledged_at) values (app_tenant_id(), $1, $2, now())
         on conflict (announcement_id, membership_id) do update set acknowledged_at = coalesce(announcement_receipts.acknowledged_at, now())
         where announcement_receipts.acknowledged_at is null`,
        [id, s.membershipId],
      );
      return one(tx, `select acknowledged_at as "acknowledgedAt" from announcement_receipts where announcement_id = $1 and membership_id = $2`, [id, s.membershipId]);
    });
  }

  // HR ---------------------------------------------------------------------------------------------------------

  async list() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      return many(
        tx,
        `select ${COLS},
                (select count(*)::int from announcement_receipts r where r.announcement_id = a.id) as "readCount",
                (select count(*)::int from announcement_receipts r where r.announcement_id = a.id and r.acknowledged_at is not null) as "ackCount",
                (select count(*)::int from employees e join memberships m on m.id = e.membership_id and m.status = 'active'
                  where ${IN_AUDIENCE} and e.status in ('active', 'notice', 'probation')) as "audienceSize"
           from ${FROM} order by a.status = 'archived', a.pinned desc, coalesce(a.published_at, a.created_at) desc limit 300`,
      );
    });
  }

  async detail(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const a = await one<Record<string, unknown>>(tx, `select ${COLS} from ${FROM} where a.id = $1`, [id]);
      if (!a) throw Errors.notFound('Announcement');
      const people = await many(
        tx,
        `select e.id as "employeeId", ${nameOf('e')} as name, dd.name as "departmentName", r.read_at as "readAt", r.acknowledged_at as "acknowledgedAt"
           from announcements a join employees e on ${IN_AUDIENCE} join memberships m on m.id = e.membership_id and m.status = 'active'
           left join departments dd on dd.id = e.current_department_id
           left join announcement_receipts r on r.announcement_id = a.id and r.membership_id = e.membership_id
          where a.id = $1 and e.status in ('active', 'notice', 'probation')
          order by r.acknowledged_at nulls first, r.read_at nulls first, name limit 5000`,
        [id],
      );
      return { ...a, people };
    });
  }

  async save(id: string | null, input: AnnouncementInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const s = await this.authz.subject(tx);
      await this.checkRefs(tx, input);
      if (id) {
        const cur = await one<{ status: string }>(tx, 'select status from announcements where id = $1', [id]);
        if (!cur) throw Errors.notFound('Announcement');
        if (cur.status === 'draft') {
          await tx.query(
            `update announcements set title = $2, body = $3, legal_entity_id = $4, department_id = $5, location_id = $6, requires_ack = $7, pinned = $8, expires_on = $9 where id = $1`,
            [id, input.title, input.body, input.legalEntityId, input.departmentId, input.locationId, input.requiresAck, input.pinned, input.expiresOn],
          );
        } else if (cur.status === 'published') {
          // Only how it is shown can change after publishing.
          await tx.query('update announcements set pinned = $2, expires_on = $3 where id = $1', [id, input.pinned, input.expiresOn]);
        } else throw Errors.conflict('archived', 'Archived announcements cannot be changed');
      } else {
        id = (await one<{ id: string }>(
          tx,
          `insert into announcements (tenant_id, title, body, legal_entity_id, department_id, location_id, requires_ack, pinned, expires_on, created_by_membership_id)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [input.title, input.body, input.legalEntityId, input.departmentId, input.locationId, input.requiresAck, input.pinned, input.expiresOn, s.membershipId],
        ))!.id;
      }
      return { id };
    });
  }

  async publish(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const s = await this.authz.subject(tx);
      const a = await one<{ status: string; title: string; requires_ack: boolean; expires_on: string | null }>(tx, `select status, title, requires_ack, to_char(expires_on, 'YYYY-MM-DD') as expires_on from announcements where id = $1`, [id]);
      if (!a) throw Errors.notFound('Announcement');
      if (a.status !== 'draft') throw Errors.conflict('not_draft', 'Only drafts can be published');
      if (a.expires_on && a.expires_on < new Date().toISOString().slice(0, 10)) throw Errors.badRequest('expired', 'The expiry date has already passed');
      const audience = await this.audience(tx, id);
      if (!audience.length) throw Errors.badRequest('empty_audience', 'Nobody is in this audience yet');
      await tx.query(`update announcements set status = 'published', published_at = now(), published_by_membership_id = $2 where id = $1`, [id, s.membershipId]);
      await this.notifications.notify(tx, {
        membershipIds: audience.map((r) => r.membership_id),
        kind: 'announcement',
        title: a.requires_ack ? `Please read and acknowledge: ${a.title}` : a.title,
        link: `/announcements/${id}`,
      });
      await this.audit.record(tx, { action: 'announcement.published', resourceType: 'announcement', resourceId: id, metadata: { audience: audience.length, requiresAck: a.requires_ack } });
      return { id, audience: audience.length };
    });
  }

  async archive(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const r = await tx.query(`update announcements set status = 'archived', pinned = false where id = $1 and status = 'published'`, [id]);
      if (!r.rowCount) throw Errors.conflict('not_published', 'Only published announcements can be archived');
      await this.audit.record(tx, { action: 'announcement.archived', resourceType: 'announcement', resourceId: id });
      return { id };
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const r = await tx.query(`delete from announcements where id = $1 and status = 'draft'`, [id]);
      if (!r.rowCount) throw Errors.conflict('not_draft', 'Only drafts can be deleted; archive a published announcement instead');
    });
  }
}
