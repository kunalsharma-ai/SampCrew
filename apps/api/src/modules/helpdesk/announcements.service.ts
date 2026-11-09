import { Injectable } from '@nestjs/common';
import type { AnnouncementInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { displayName, fieldById, memberNames } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const AUDIENCE_STATUSES = ['active', 'notice', 'probation'];

/**
 * Who an announcement reaches: a legal entity, location and department (with its sub-departments), each optional.
 * Built once per request, since it needs the department tree.
 */
async function audienceTest(tx: TenantTx) {
  const departments = await tx.collection('departments').find({}, { projection: { parent_id: 1 } });
  const children = new Map<string, string[]>();
  for (const d of departments) if (d.parent_id) children.set(d.parent_id, [...(children.get(d.parent_id) ?? []), d.id]);
  const subtrees = new Map<string, Set<string>>();
  const subtree = (id: string) => {
    let out = subtrees.get(id);
    if (!out) {
      out = new Set([id]);
      for (let frontier = [id]; frontier.length; ) frontier = frontier.flatMap((x) => children.get(x) ?? []).filter((x) => !out!.has(x) && out!.add(x));
      subtrees.set(id, out);
    }
    return out;
  };
  return (a: Doc, e: Doc) =>
    (!a.legal_entity_id || e.current_legal_entity_id === a.legal_entity_id) &&
    (!a.location_id || e.current_location_id === a.location_id) &&
    (!a.department_id || (!!e.current_department_id && subtree(a.department_id).has(e.current_department_id)));
}

/** Current employees with an active login: the people an announcement can reach. */
async function reachable(tx: TenantTx): Promise<Doc[]> {
  const emps = await tx.collection('employees').find({ status: { $in: AUDIENCE_STATUSES }, membership_id: { $ne: null } });
  const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: emps.map((e) => e.membership_id) }, status: 'active' }));
  return emps.filter((e) => active.has(e.membership_id));
}

/** Announcements as the API shows them, with the audience and the publisher by name. */
async function views(tx: TenantTx, docs: Doc[]): Promise<Doc[]> {
  const [entities, departments, locations, publishers] = await Promise.all([
    fieldById(tx, 'legal_entities', docs.map((a) => a.legal_entity_id)),
    fieldById(tx, 'departments', docs.map((a) => a.department_id)),
    fieldById(tx, 'locations', docs.map((a) => a.location_id)),
    memberNames(tx, docs.map((a) => a.published_by_membership_id)),
  ]);
  return docs.map((a) => ({
    id: a.id, title: a.title, body: a.body, legalEntityId: a.legal_entity_id ?? null, legalEntityName: entities.get(a.legal_entity_id) ?? null,
    departmentId: a.department_id ?? null, departmentName: departments.get(a.department_id) ?? null, locationId: a.location_id ?? null,
    locationName: locations.get(a.location_id) ?? null, requiresAck: a.requires_ack, pinned: a.pinned, status: a.status, publishedAt: a.published_at ?? null,
    expiresOn: a.expires_on ?? null, createdAt: a.created_at, updatedAt: a.updated_at,
    publishedByName: a.published_by_membership_id ? (publishers.get(a.published_by_membership_id) ?? null) : null,
  }));
}

const today = () => new Date().toISOString().slice(0, 10);

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

  private async audience(tx: TenantTx, id: string) {
    const a = await tx.collection('announcements').findOne({ id });
    if (!a) return [];
    const reaches = await audienceTest(tx);
    return (await reachable(tx)).filter((e) => reaches(a, e)).map((e) => ({ membership_id: e.membership_id as string }));
  }

  /** Whether the employee is in the announcement's audience. */
  private async addressedTo(tx: TenantTx, a: Doc, employeeId: string | null | undefined): Promise<boolean> {
    if (!employeeId) return false;
    const e = await tx.collection('employees').findOne({ id: employeeId });
    return !!e && (await audienceTest(tx))(a, e);
  }

  private async checkRefs(tx: TenantTx, input: AnnouncementInput) {
    if (input.legalEntityId && !(await tx.collection('legal_entities').exists({ id: input.legalEntityId }))) throw Errors.badRequest('unknown_legal_entity', 'Choose an existing legal entity');
    if (input.departmentId && !(await tx.collection('departments').exists({ id: input.departmentId }))) throw Errors.badRequest('unknown_department', 'Choose an existing department');
    if (input.locationId && !(await tx.collection('locations').exists({ id: input.locationId }))) throw Errors.badRequest('unknown_location', 'Choose an existing location');
  }

  /** The caller's feed: published, unexpired announcements addressed to them, pinned first. */
  async feed(limit = 50) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) return [];
      const e = await tx.collection('employees').findOne({ id: s.employeeId });
      if (!e) return [];
      const reaches = await audienceTest(tx);
      const live = (await tx.collection('announcements').find({ status: 'published', $or: [{ expires_on: null }, { expires_on: { $gte: today() } }] }, { sort: { pinned: -1, published_at: -1 } }))
        .filter((a) => reaches(a, e))
        .slice(0, limit);
      const receipts = new Map((await tx.collection('announcement_receipts').find({ announcement_id: { $in: live.map((a) => a.id) }, membership_id: s.membershipId })).map((r) => [r.announcement_id as string, r]));
      return (await views(tx, live)).map((a) => ({ ...a, readAt: receipts.get(a.id)?.read_at ?? null, acknowledgedAt: receipts.get(a.id)?.acknowledged_at ?? null }));
    });
  }

  /** Opens one announcement from the feed and records the first read. */
  async read(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const manage = hasPermission(s, 'announcements:manage').allowed;
      const doc = await tx.collection('announcements').findOne({ id });
      const inAudience = !!doc && doc.status === 'published' && (await this.addressedTo(tx, doc, s.employeeId));
      if (!doc || (!inAudience && !manage)) throw Errors.notFound('Announcement');
      const a = (await views(tx, [doc]))[0]!;
      let receipt: { readAt: Date; acknowledgedAt: Date | null } | null = null;
      if (inAudience) {
        const receipts = tx.collection('announcement_receipts');
        if (!(await receipts.exists({ announcement_id: id, membership_id: s.membershipId }))) {
          await receipts.insert({ announcement_id: id, membership_id: s.membershipId }).catch((err: { code?: string }) => {
            if (err.code !== '23505') throw err;
          });
        }
        const r = (await receipts.findOne({ announcement_id: id, membership_id: s.membershipId }))!;
        receipt = { readAt: r.read_at, acknowledgedAt: r.acknowledged_at ?? null };
      }
      return { ...a, readAt: receipt?.readAt ?? null, acknowledgedAt: receipt?.acknowledgedAt ?? null, inAudience: receipt !== null, canManage: manage };
    });
  }

  async acknowledge(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const a = await tx.collection('announcements').findOne({ id, status: 'published' });
      if (!a || !(await this.addressedTo(tx, a, s.employeeId))) throw Errors.notFound('Announcement');
      if (!a.requires_ack) throw Errors.badRequest('no_ack_needed', 'This announcement does not ask for an acknowledgement');
      const receipts = tx.collection('announcement_receipts');
      const now = new Date();
      await receipts.upsert({ announcement_id: id, membership_id: s.membershipId }, { announcement_id: id, membership_id: s.membershipId, acknowledged_at: now });
      await receipts.updateOne({ announcement_id: id, membership_id: s.membershipId, acknowledged_at: null }, { $set: { acknowledged_at: now } });
      const r = (await receipts.findOne({ announcement_id: id, membership_id: s.membershipId }))!;
      return { acknowledgedAt: r.acknowledged_at };
    });
  }

  // HR ---------------------------------------------------------------------------------------------------------

  async list() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const docs = await tx.collection('announcements').find({});
      const at = (a: Doc) => new Date(a.published_at ?? a.created_at).getTime();
      docs.sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || Number(b.pinned) - Number(a.pinned) || at(b) - at(a));
      const shown = docs.slice(0, 300);
      const receipts = await tx.collection('announcement_receipts').find({ announcement_id: { $in: shown.map((a) => a.id) } }, { projection: { announcement_id: 1, acknowledged_at: 1 } });
      const people = await reachable(tx);
      const reaches = await audienceTest(tx);
      return (await views(tx, shown)).map((a, i) => ({
        ...a,
        readCount: receipts.filter((r) => r.announcement_id === a.id).length,
        ackCount: receipts.filter((r) => r.announcement_id === a.id && r.acknowledged_at).length,
        audienceSize: people.filter((e) => reaches(shown[i]!, e)).length,
      }));
    });
  }

  async detail(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const doc = await tx.collection('announcements').findOne({ id });
      if (!doc) throw Errors.notFound('Announcement');
      const a = (await views(tx, [doc]))[0]!;
      const reaches = await audienceTest(tx);
      const emps = (await reachable(tx)).filter((e) => reaches(doc, e));
      const departments = await fieldById(tx, 'departments', emps.map((e) => e.current_department_id));
      const receipts = new Map((await tx.collection('announcement_receipts').find({ announcement_id: id })).map((r) => [r.membership_id as string, r]));
      const t = (v: unknown) => (v ? new Date(v as Date).getTime() : -Infinity);
      const people = emps
        .map((e) => {
          const r = receipts.get(e.membership_id);
          return { employeeId: e.id, name: displayName(e as never), departmentName: departments.get(e.current_department_id) ?? null, readAt: r?.read_at ?? null, acknowledgedAt: r?.acknowledged_at ?? null };
        })
        .sort((x, y) => t(x.acknowledgedAt) - t(y.acknowledgedAt) || t(x.readAt) - t(y.readAt) || x.name.localeCompare(y.name))
        .slice(0, 5000);
      return { ...a, people };
    });
  }

  async save(id: string | null, input: AnnouncementInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const s = await this.authz.subject(tx);
      await this.checkRefs(tx, input);
      if (id) {
        const announcements = tx.collection('announcements');
        const cur = await announcements.findOne({ id });
        if (!cur) throw Errors.notFound('Announcement');
        if (cur.status === 'draft') {
          await announcements.updateOne({ id }, {
            $set: {
              title: input.title, body: input.body, legal_entity_id: input.legalEntityId ?? null, department_id: input.departmentId ?? null, location_id: input.locationId ?? null,
              requires_ack: input.requiresAck, pinned: input.pinned, expires_on: input.expiresOn ?? null,
            },
          });
        } else if (cur.status === 'published') {
          // Only how it is shown can change after publishing.
          await announcements.updateOne({ id }, { $set: { pinned: input.pinned, expires_on: input.expiresOn ?? null } });
        } else throw Errors.conflict('archived', 'Archived announcements cannot be changed');
      } else {
        id = (await tx.collection('announcements').insert({
          title: input.title, body: input.body, legal_entity_id: input.legalEntityId ?? null, department_id: input.departmentId ?? null, location_id: input.locationId ?? null,
          requires_ack: input.requiresAck, pinned: input.pinned, expires_on: input.expiresOn ?? null, created_by_membership_id: s.membershipId,
        })).id as string;
      }
      return { id };
    });
  }

  async publish(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const s = await this.authz.subject(tx);
      const a = await tx.collection<{ status: string; title: string; requires_ack: boolean; expires_on: string | null }>('announcements').findOne({ id });
      if (!a) throw Errors.notFound('Announcement');
      if (a.status !== 'draft') throw Errors.conflict('not_draft', 'Only drafts can be published');
      if (a.expires_on && a.expires_on < new Date().toISOString().slice(0, 10)) throw Errors.badRequest('expired', 'The expiry date has already passed');
      const audience = await this.audience(tx, id);
      if (!audience.length) throw Errors.badRequest('empty_audience', 'Nobody is in this audience yet');
      await tx.collection('announcements').updateOne({ id }, { $set: { status: 'published', published_at: new Date(), published_by_membership_id: s.membershipId } });
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
      if (!(await tx.collection('announcements').updateOne({ id, status: 'published' }, { $set: { status: 'archived', pinned: false } }))) throw Errors.conflict('not_published', 'Only published announcements can be archived');
      await this.audit.record(tx, { action: 'announcement.archived', resourceType: 'announcement', resourceId: id });
      return { id };
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      if (!(await tx.collection('announcements').deleteOne({ id, status: 'draft' }))) throw Errors.conflict('not_draft', 'Only drafts can be deleted; archive a published announcement instead');
    });
  }
}
