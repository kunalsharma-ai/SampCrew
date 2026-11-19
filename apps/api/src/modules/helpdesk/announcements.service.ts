import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ANNOUNCEMENT_CATEGORY_LABELS, EMPTY_AUDIENCE, htmlToText, type AnnouncementCategory, type AnnouncementInput, type AnnouncementPriority, type AudienceInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { describeAudience, resolveAudience, safeHtml } from '../communication/audience';
import { displayName, fieldById, memberNames } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Subject = { employeeId?: string | null; membershipId: string };

const AUDIENCE_STATUSES = ['active', 'notice', 'probation'];
/** Notification priority for each announcement priority (urgent ones also make a sound for most people). */
const NOTICE_PRIORITY: Record<AnnouncementPriority, 'normal' | 'high' | 'urgent'> = { normal: 'normal', important: 'high', urgent: 'urgent' };
const PRIORITY_RANK: Record<string, number> = { urgent: 2, important: 1, normal: 0 };
/** HR can remind people who have not acknowledged at most this often. */
const REMIND_EVERY_MS = 60 * 60 * 1000;

const asAudience = (a: Doc | null | undefined): AudienceInput | null => (a ? { ...EMPTY_AUDIENCE, ...a } : null);
const link = (id: string) => `/announcements/${id}`;

/**
 * Who announcements reach. The older addressing (legal entity, location and department with its sub-departments,
 * each optional) still applies; a new-style `audience` (everyone, or departments, designations, groups and people)
 * is resolved once per announcement, and legal entity and location narrow it further. Built once per request.
 */
async function audienceTest(tx: TenantTx, docs: Doc[]) {
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
  const chosen = new Map<string, Set<string>>();
  for (const a of docs) {
    const aud = asAudience(a.audience);
    if (aud) chosen.set(a.id, new Set((await resolveAudience(tx, aud, { lenient: true })).map((m) => m.membershipId)));
  }
  return (a: Doc, e: Doc) =>
    (!a.legal_entity_id || e.current_legal_entity_id === a.legal_entity_id) &&
    (!a.location_id || e.current_location_id === a.location_id) &&
    (!a.department_id || (!!e.current_department_id && subtree(a.department_id).has(e.current_department_id))) &&
    (!a.audience || !!chosen.get(a.id)?.has(e.membership_id));
}

/** A member without an employee record (often the workspace owner or an admin), placed by their login's own placement. */
const memberPlacement = (m: Doc): Doc => ({
  membership_id: m.id, current_legal_entity_id: m.legal_entity_id ?? null, current_department_id: m.department_id ?? null, current_location_id: m.location_id ?? null,
});

/**
 * The people an announcement can reach: current employees with an active login, and active members who have no
 * employee record (placed by their login), so the owner and admins who are not on the employee list see it too.
 */
async function reachable(tx: TenantTx): Promise<Doc[]> {
  const emps = await tx.collection('employees').find({ status: { $in: AUDIENCE_STATUSES }, membership_id: { $ne: null } });
  const linked = new Set(await tx.collection('employees').distinct<string>('membership_id', { membership_id: { $ne: null } }));
  const members = await tx.collection('memberships').find({ status: 'active' });
  const active = new Set(members.map((m) => m.id as string));
  return [...emps.filter((e) => active.has(e.membership_id)), ...members.filter((m) => !linked.has(m.id)).map(memberPlacement)];
}

/** Where the caller sits for announcements: their employee record, or their login's placement when they have none. */
async function placementOf(tx: TenantTx, s: Subject): Promise<Doc | null> {
  if (s.employeeId) {
    const e = await tx.collection('employees').findOne({ id: s.employeeId });
    return e ? { ...e, membership_id: s.membershipId } : null;
  }
  const m = await tx.collection('memberships').findOne({ id: s.membershipId });
  return m ? memberPlacement(m) : null;
}

/** Announcements as the API shows them, with the audience, files and the publisher by name. */
async function views(tx: TenantTx, docs: Doc[]): Promise<Doc[]> {
  const [entities, departments, locations, people] = await Promise.all([
    fieldById(tx, 'legal_entities', docs.map((a) => a.legal_entity_id)),
    fieldById(tx, 'departments', docs.map((a) => a.department_id)),
    fieldById(tx, 'locations', docs.map((a) => a.location_id)),
    memberNames(tx, docs.flatMap((a) => [a.published_by_membership_id, a.edited_by_membership_id, a.scheduled_by_membership_id])),
  ]);
  const fileIds = [...new Set(docs.flatMap((a) => (a.file_ids as string[] | undefined) ?? []))];
  const fileRows = fileIds.length ? await tx.collection('comm_files').find({ id: { $in: fileIds } }, { projection: { name: 1, type: 1, size: 1 } }) : [];
  const files = new Map(fileRows.map((f) => [f.id as string, { id: f.id as string, name: f.name as string, type: f.type as string, size: f.size as number, href: `/announcement-files/${f.id}` }]));
  const out: Doc[] = [];
  for (const a of docs) {
    const audience = asAudience(a.audience);
    const parts = [audience ? await describeAudience(tx, audience) : null, entities.get(a.legal_entity_id), departments.get(a.department_id), locations.get(a.location_id)].filter(Boolean);
    out.push({
      id: a.id, title: a.title, body: a.body, html: a.body_html ?? null, audience, audienceLabel: !audience && parts.length === 0 ? 'Everyone' : parts.join(' · '),
      legalEntityId: a.legal_entity_id ?? null, legalEntityName: entities.get(a.legal_entity_id) ?? null,
      departmentId: a.department_id ?? null, departmentName: departments.get(a.department_id) ?? null, locationId: a.location_id ?? null,
      locationName: locations.get(a.location_id) ?? null, requiresAck: a.requires_ack, pinned: a.pinned, status: a.status,
      category: (a.category ?? 'general') as AnnouncementCategory, categoryLabel: ANNOUNCEMENT_CATEGORY_LABELS[(a.category ?? 'general') as AnnouncementCategory],
      priority: (a.priority ?? 'normal') as AnnouncementPriority,
      files: ((a.file_ids as string[] | undefined) ?? []).map((f) => files.get(f)).filter(Boolean),
      publishedAt: a.published_at ?? null, publishAt: a.publish_at ?? null, expiresOn: a.expires_on ?? null, createdAt: a.created_at, updatedAt: a.updated_at,
      version: a.version ?? 1, ackVersion: a.ack_version ?? 1, editedAt: a.edited_at ?? null, editedByName: a.edited_by_membership_id ? (people.get(a.edited_by_membership_id) ?? null) : null,
      deletedAt: a.deleted_at ?? null,
      publishedByName: a.published_by_membership_id ? (people.get(a.published_by_membership_id) ?? null) : null,
      scheduledByName: a.scheduled_by_membership_id ? (people.get(a.scheduled_by_membership_id) ?? null) : null,
    });
  }
  return out;
}

/** Whether a receipt's acknowledgement is for the announcement's current wording. */
const ackCurrent = (a: Doc, r: Doc | undefined) => !!r?.acknowledged_at && Number(r.acknowledged_version ?? 1) >= Number(a.ack_version ?? 1);

const today = () => new Date().toISOString().slice(0, 10);
const live = () => ({ status: 'published', deleted_at: null, $or: [{ expires_on: null }, { expires_on: { $gte: today() } }] });

/**
 * Announcements from HR to everyone or to any mix of departments, designations, groups and people (optionally only
 * in one legal entity or location), with a category, priority, rich text and attachments. They can be published now
 * or scheduled. Publishing notifies the audience (urgent ones loudly). A published announcement can be edited: each
 * change is a new version, and HR can ask everyone to acknowledge the new wording again, so an acknowledgement always
 * refers to a version the person saw. Read and acknowledgement times are kept, also when an announcement is deleted.
 */
@Injectable()
export class AnnouncementsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Announcements');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Scheduled announcements go out within a minute of their time (and whenever someone opens the feed). */
  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    this.timer = setInterval(() => void this.publishAllDue().catch((err: Error) => this.logger.error(`Scheduled announcements failed: ${err.message}`)), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Publishes every workspace's announcements that are due. Each is published once (status moves on in the same step). */
  async publishAllDue() {
    const tenants = await this.db.platform((tx) => tx.collection('announcements').distinct<string>('tenant_id', { status: 'scheduled', publish_at: { $lte: new Date() } }));
    let published = 0;
    for (const tenantId of tenants) published += await this.db.tenant((tx) => this.publishDue(tx), { tenantId });
    return published;
  }

  private async publishDue(tx: TenantTx) {
    const due = await tx.collection('announcements').find({ status: 'scheduled', publish_at: { $lte: new Date() } }, { limit: 50 });
    let n = 0;
    for (const a of due) {
      const by = a.scheduled_by_membership_id ?? a.created_by_membership_id;
      const audience = await this.audience(tx, a);
      if (!audience.length) {
        // Nobody to send it to any more: back to a draft, and the person who scheduled it is told.
        await tx.collection('announcements').updateOne({ id: a.id, status: 'scheduled' }, { $set: { status: 'draft', publish_at: null } });
        await this.notifications.notify(tx, { membershipIds: [by], kind: 'announcement.not_published', title: `"${a.title}" was not published: nobody is in its audience`, link: `/announcements/manage/${a.id}`, priority: 'high' });
        continue;
      }
      if (await tx.collection('announcements').updateOne({ id: a.id, status: 'scheduled' }, { $set: { status: 'published', published_at: new Date(), published_by_membership_id: by } })) {
        await this.announce(tx, { ...a, status: 'published' }, audience);
        await this.audit.record(tx, { action: 'announcement.published', resourceType: 'announcement', resourceId: a.id, metadata: { audience: audience.length, requiresAck: a.requires_ack, scheduled: true } });
        n++;
      }
    }
    return n;
  }

  private async audience(tx: TenantTx, a: Doc): Promise<string[]> {
    const reaches = await audienceTest(tx, [a]);
    return (await reachable(tx)).filter((e) => reaches(a, e)).map((e) => e.membership_id as string);
  }

  /** Whether the caller is in the announcement's audience. */
  private async addressedTo(tx: TenantTx, a: Doc, s: Subject): Promise<boolean> {
    const e = await placementOf(tx, s);
    return !!e && (await audienceTest(tx, [a]))(a, e);
  }

  /** Tells the audience: a notification (priority from the announcement) and a live refresh of open feeds. */
  private async announce(tx: TenantTx, a: Doc, audience: string[], updated = false) {
    const prefix = updated ? 'Updated' : a.priority === 'urgent' ? 'Urgent' : null;
    const ask = a.requires_ack ? 'Please read and acknowledge: ' : '';
    await this.notifications.notify(tx, {
      membershipIds: audience,
      kind: updated ? 'announcement.updated' : 'announcement',
      category: 'announcements',
      title: `${prefix ? `${prefix}: ` : ''}${ask}${a.title}`,
      body: String(a.body ?? '').slice(0, 200),
      link: link(a.id),
      priority: NOTICE_PRIORITY[(a.priority ?? 'normal') as AnnouncementPriority],
      dedupeKey: `announcement:${a.id}:${a.ack_version ?? 1}`,
      // Urgent ones also go by email (unless the person turned announcement emails off).
      email: a.priority === 'urgent',
      actorMembershipId: a.published_by_membership_id ?? null,
    });
    await this.notifications.signal(tx, audience, 'announcements.changed', { announcementId: a.id });
  }

  private async checkRefs(tx: TenantTx, input: AnnouncementInput) {
    if (input.legalEntityId && !(await tx.collection('legal_entities').exists({ id: input.legalEntityId }))) throw Errors.badRequest('unknown_legal_entity', 'Choose an existing legal entity');
    if (input.departmentId && !(await tx.collection('departments').exists({ id: input.departmentId }))) throw Errors.badRequest('unknown_department', 'Choose an existing department');
    if (input.locationId && !(await tx.collection('locations').exists({ id: input.locationId }))) throw Errors.badRequest('unknown_location', 'Choose an existing location');
    if (input.audience) await resolveAudience(tx, input.audience); // refuses unknown groups
    if (input.fileIds.length && (await tx.collection('comm_files').count({ id: { $in: input.fileIds } })) !== new Set(input.fileIds).size) throw Errors.badRequest('unknown_file', 'One of the files is missing; attach it again');
  }

  // Everyone ---------------------------------------------------------------------------------------------------

  /** The caller's feed: published, unexpired announcements addressed to them, pinned first, then urgent, then newest. */
  async feed(q: { category?: string; unread?: string; q?: string } = {}, limit = 100) {
    return this.db.tenant(async (tx) => {
      await this.publishDue(tx);
      const s = await this.authz.subject(tx);
      const e = await placementOf(tx, s);
      if (!e) return [];
      const docs = await tx.collection('announcements').find({ ...live(), ...(q.category ? { category: q.category } : {}) }, { sort: { pinned: -1, published_at: -1 }, limit: 500 });
      const reaches = await audienceTest(tx, docs);
      let mine = docs.filter((a) => reaches(a, e));
      if (q.q) {
        const needle = q.q.toLowerCase();
        mine = mine.filter((a) => `${a.title} ${a.body}`.toLowerCase().includes(needle));
      }
      const receipts = new Map((await tx.collection('announcement_receipts').find({ announcement_id: { $in: mine.map((a) => a.id) }, membership_id: s.membershipId })).map((r) => [r.announcement_id as string, r]));
      if (q.unread === 'true') mine = mine.filter((a) => !receipts.has(a.id) || (a.requires_ack && !ackCurrent(a, receipts.get(a.id))));
      mine.sort((x, y) => Number(y.pinned) - Number(x.pinned) || (PRIORITY_RANK[y.priority] ?? 0) - (PRIORITY_RANK[x.priority] ?? 0) || new Date(y.published_at).getTime() - new Date(x.published_at).getTime());
      mine = mine.slice(0, limit);
      return (await views(tx, mine)).map((a, i) => this.withReceipt(a, mine[i]!, receipts.get(a.id)));
    });
  }

  private withReceipt(view: Doc, a: Doc, r: Doc | undefined) {
    const current = ackCurrent(a, r);
    return {
      ...view,
      readAt: r?.read_at ?? null,
      acknowledgedAt: current ? r!.acknowledged_at : null,
      // Acknowledged an earlier wording: the screen says it changed and asks again.
      acknowledgedEarlierAt: !current && r?.acknowledged_at ? r.acknowledged_at : null,
      needsAck: !!a.requires_ack && !current,
    };
  }

  /** What is new for the caller (the menu badge): unread announcements and those waiting for an acknowledgement. */
  async unread() {
    const items = await this.feed({ unread: 'true' });
    return { unread: items.filter((a) => !a.readAt).length, toAcknowledge: items.filter((a) => a.needsAck).length, total: items.length };
  }

  /** Opens one announcement and records the first read (and clears its notification). */
  async read(id: string) {
    return this.db.tenant(async (tx) => {
      await this.publishDue(tx);
      const s = await this.authz.subject(tx);
      const manage = hasPermission(s, 'announcements:manage').allowed;
      const doc = await tx.collection('announcements').findOne({ id });
      const inAudience = !!doc && doc.status === 'published' && !doc.deleted_at && (await this.addressedTo(tx, doc, s));
      if (!doc || (!inAudience && !manage)) throw Errors.notFound('Announcement');
      const a = (await views(tx, [doc]))[0]!;
      let receipt: Doc | undefined;
      if (inAudience) {
        const receipts = tx.collection('announcement_receipts');
        if (!(await receipts.exists({ announcement_id: id, membership_id: s.membershipId }))) {
          await receipts.insert({ announcement_id: id, membership_id: s.membershipId }).catch((err: { code?: string }) => {
            if (err.code !== '23505') throw err;
          });
        }
        receipt = (await receipts.findOne({ announcement_id: id, membership_id: s.membershipId }))!;
        if (!doc.requires_ack || ackCurrent(doc, receipt)) await this.notifications.markReadByLink(tx, s.membershipId, link(id));
      }
      return { ...this.withReceipt(a, doc, receipt), inAudience: !!receipt, canManage: manage };
    });
  }

  async acknowledge(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const a = await tx.collection('announcements').findOne({ id, status: 'published', deleted_at: null });
      if (!a || !(await this.addressedTo(tx, a, s))) throw Errors.notFound('Announcement');
      if (!a.requires_ack) throw Errors.badRequest('no_ack_needed', 'This announcement does not ask for an acknowledgement');
      const receipts = tx.collection('announcement_receipts');
      const now = new Date();
      const version = Number(a.ack_version ?? 1);
      const cur = await receipts.findOne({ announcement_id: id, membership_id: s.membershipId });
      if (!cur) {
        await receipts.insert({ announcement_id: id, membership_id: s.membershipId, acknowledged_at: now, acknowledged_version: version }).catch((err: { code?: string }) => {
          if (err.code !== '23505') throw err;
        });
      } else if (!cur.acknowledged_at) {
        await receipts.updateOne({ announcement_id: id, membership_id: s.membershipId, acknowledged_at: null }, { $set: { acknowledged_at: now, acknowledged_version: version } });
      } else if (!ackCurrent(a, cur)) {
        // A newer wording: the earlier acknowledgement is kept in the history.
        await receipts.updateOne({ announcement_id: id, membership_id: s.membershipId }, {
          $set: { acknowledged_at: now, acknowledged_version: version, ack_history: [...((cur.ack_history as Doc[] | undefined) ?? []), { version: cur.acknowledged_version ?? 1, at: cur.acknowledged_at }] },
        });
      }
      const r = (await receipts.findOne({ announcement_id: id, membership_id: s.membershipId }))!;
      await this.notifications.markReadByLink(tx, s.membershipId, link(id));
      return { acknowledgedAt: r.acknowledged_at, version: r.acknowledged_version ?? 1 };
    });
  }

  /** A short download link for an announcement's file, for people the announcement is addressed to (and HR). */
  async fileLink(fileId: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const manage = hasPermission(s, 'announcements:manage').allowed;
      const docs = await tx.collection('announcements').find({ file_ids: fileId });
      let allowed = manage && docs.length > 0;
      for (const a of docs) {
        if (allowed) break;
        allowed = a.status === 'published' && !a.deleted_at && (await this.addressedTo(tx, a, s));
      }
      // Files HR uploaded but has not attached yet.
      if (!allowed && manage) allowed = await tx.collection('comm_files').exists({ id: fileId, uploaded_by_membership_id: s.membershipId });
      if (!allowed) throw Errors.notFound('File');
      return this.storage.sign(fileId, 300, 'comm');
    });
  }

  // HR ---------------------------------------------------------------------------------------------------------

  async list(q: { deleted?: string } = {}) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      await this.publishDue(tx);
      const docs = await tx.collection('announcements').find(q.deleted === 'true' ? { deleted_at: { $ne: null } } : { deleted_at: null });
      const at = (a: Doc) => new Date(a.published_at ?? a.publish_at ?? a.created_at).getTime();
      const order: Record<string, number> = { scheduled: 0, draft: 1, published: 2, archived: 3 };
      docs.sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived') || Number(b.pinned) - Number(a.pinned) || (order[a.status] ?? 9) - (order[b.status] ?? 9) || at(b) - at(a));
      const shown = docs.slice(0, 300);
      const receipts = await tx.collection('announcement_receipts').find({ announcement_id: { $in: shown.map((a) => a.id) } }, { projection: { announcement_id: 1, acknowledged_at: 1, acknowledged_version: 1 } });
      const people = await reachable(tx);
      const reaches = await audienceTest(tx, shown);
      return (await views(tx, shown)).map((a, i) => {
        const doc = shown[i]!;
        const mine = receipts.filter((r) => r.announcement_id === a.id);
        return { ...a, readCount: mine.length, ackCount: mine.filter((r) => ackCurrent(doc, r)).length, audienceSize: people.filter((e) => reaches(doc, e)).length };
      });
    });
  }

  async detail(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const doc = await tx.collection('announcements').findOne({ id });
      if (!doc) throw Errors.notFound('Announcement');
      const a = (await views(tx, [doc]))[0]!;
      const reaches = await audienceTest(tx, [doc]);
      const emps = (await reachable(tx)).filter((e) => reaches(doc, e));
      const departments = await fieldById(tx, 'departments', emps.map((e) => e.current_department_id));
      // Members without an employee record are listed by their login's name.
      const loginNames = await memberNames(tx, emps.filter((e) => !e.id).map((e) => e.membership_id));
      const receipts = new Map((await tx.collection('announcement_receipts').find({ announcement_id: id })).map((r) => [r.membership_id as string, r]));
      const t = (v: unknown) => (v ? new Date(v as Date).getTime() : -Infinity);
      const people = emps
        .map((e) => {
          const r = receipts.get(e.membership_id);
          const current = ackCurrent(doc, r);
          return {
            employeeId: (e.id as string | undefined) ?? null, membershipId: e.membership_id as string,
            name: e.id ? displayName(e as never) : (loginNames.get(e.membership_id) ?? 'Workspace member'), departmentName: departments.get(e.current_department_id) ?? null,
            readAt: r?.read_at ?? null, acknowledgedAt: current ? r!.acknowledged_at : null, acknowledgedEarlierAt: !current && r?.acknowledged_at ? r.acknowledged_at : null,
          };
        })
        .sort((x, y) => t(x.acknowledgedAt) - t(y.acknowledgedAt) || t(x.readAt) - t(y.readAt) || x.name.localeCompare(y.name))
        .slice(0, 5000);
      const remindedAt = doc.reminded_at ?? null;
      return { ...a, people, remindedAt, canRemind: doc.status === 'published' && !doc.deleted_at && doc.requires_ack && (!remindedAt || Date.now() - new Date(remindedAt).getTime() >= REMIND_EVERY_MS) };
    });
  }

  /** The fields a save writes, from the input. Rich text is cleaned; the plain text is worked out from it. */
  private fields(input: AnnouncementInput) {
    const html = input.html ? safeHtml(input.html) : null;
    const body = (html ? htmlToText(html) : input.body).slice(0, 20_000);
    if (!body) throw Errors.badRequest('empty_body', 'Write the message');
    return {
      title: input.title, body, body_html: html, audience: input.audience, legal_entity_id: input.legalEntityId ?? null,
      // A new-style audience chooses departments itself; the single department is the older addressing.
      department_id: input.audience ? null : (input.departmentId ?? null), location_id: input.locationId ?? null,
      category: input.category, priority: input.priority, file_ids: input.fileIds, requires_ack: input.requiresAck, pinned: input.pinned, expires_on: input.expiresOn ?? null,
    };
  }

  async save(id: string | null, input: AnnouncementInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const s = await this.authz.subject(tx);
      await this.checkRefs(tx, input);
      const f = this.fields(input);
      const announcements = tx.collection('announcements');
      if (!id) {
        id = (await announcements.insert({ ...f, created_by_membership_id: s.membershipId })).id as string;
        return { id, version: 1 };
      }
      const cur = await announcements.findOne({ id, deleted_at: null });
      if (!cur) throw Errors.notFound('Announcement');
      if (cur.status === 'archived') throw Errors.conflict('archived', 'Archived announcements cannot be changed');
      if (cur.status === 'draft' || cur.status === 'scheduled') {
        await announcements.updateOne({ id }, { $set: f });
        return { id, version: 1 };
      }
      // Published: what people see changes as a new version; pinning, expiry, category and priority just change.
      const reworded = (['title', 'body', 'body_html', 'audience', 'legal_entity_id', 'department_id', 'location_id', 'file_ids', 'requires_ack'] as const)
        .some((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(f[k] ?? null));
      const askAgain = reworded && input.askAgain && f.requires_ack && cur.requires_ack;
      const version = Number(cur.version ?? 1) + (reworded ? 1 : 0);
      const ackVersion = Number(cur.ack_version ?? 1) + (askAgain ? 1 : 0);
      await announcements.updateOne({ id }, {
        $set: reworded
          ? { ...f, version, ack_version: ackVersion, edited_at: new Date(), edited_by_membership_id: s.membershipId }
          : { pinned: f.pinned, expires_on: f.expires_on, category: f.category, priority: f.priority },
      });
      if (reworded) {
        const after = { ...cur, ...f, version, ack_version: ackVersion };
        const audience = await this.audience(tx, after);
        // People asked to acknowledge again are notified; otherwise open feeds just refresh.
        if (askAgain) await this.announce(tx, after, audience, true);
        else await this.notifications.signal(tx, audience, 'announcements.changed', { announcementId: id });
        await this.audit.record(tx, {
          action: 'announcement.edited', resourceType: 'announcement', resourceId: id,
          metadata: { version, askAgain, previous: { title: cur.title, body: String(cur.body).slice(0, 2000) } },
        });
      }
      return { id, version };
    });
  }

  /** Publishes a draft now, or schedules it (also changes or brings forward the time of a scheduled one). */
  async publish(id: string, publishAt: string | null = null) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const s = await this.authz.subject(tx);
      const a = await tx.collection('announcements').findOne({ id, deleted_at: null });
      if (!a) throw Errors.notFound('Announcement');
      if (a.status !== 'draft' && a.status !== 'scheduled') throw Errors.conflict('not_draft', 'Only drafts and scheduled announcements can be published');
      const at = publishAt ? new Date(publishAt) : null;
      if (a.expires_on && a.expires_on < (at ?? new Date()).toISOString().slice(0, 10)) throw Errors.badRequest('expired', 'The expiry date is before it would be published');
      const audience = await this.audience(tx, a);
      if (!audience.length) throw Errors.badRequest('empty_audience', 'Nobody is in this audience yet');
      if (at && at.getTime() > Date.now() + 30_000) {
        if (at.getTime() > Date.now() + 366 * 86_400_000) throw Errors.badRequest('too_far', 'Schedule it within a year');
        await tx.collection('announcements').updateOne({ id }, { $set: { status: 'scheduled', publish_at: at, scheduled_by_membership_id: s.membershipId } });
        await this.audit.record(tx, { action: 'announcement.scheduled', resourceType: 'announcement', resourceId: id, metadata: { publishAt: at.toISOString(), audience: audience.length } });
        return { id, audience: audience.length, scheduledFor: at.toISOString() };
      }
      await tx.collection('announcements').updateOne({ id }, { $set: { status: 'published', published_at: new Date(), published_by_membership_id: s.membershipId } });
      await this.announce(tx, { ...a, status: 'published' }, audience);
      await this.audit.record(tx, { action: 'announcement.published', resourceType: 'announcement', resourceId: id, metadata: { audience: audience.length, requiresAck: a.requires_ack, priority: a.priority ?? 'normal' } });
      return { id, audience: audience.length, scheduledFor: null };
    });
  }

  /** A scheduled announcement goes back to being a draft. */
  async unschedule(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      if (!(await tx.collection('announcements').updateOne({ id, status: 'scheduled', deleted_at: null }, { $set: { status: 'draft', publish_at: null } }))) throw Errors.conflict('not_scheduled', 'It is not scheduled');
      await this.audit.record(tx, { action: 'announcement.unscheduled', resourceType: 'announcement', resourceId: id });
      return { id };
    });
  }

  /** Reminds everyone who has not acknowledged the current wording (at most once an hour). */
  async remind(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const a = await tx.collection('announcements').findOne({ id, status: 'published', deleted_at: null });
      if (!a) throw Errors.notFound('Announcement');
      if (!a.requires_ack) throw Errors.badRequest('no_ack_needed', 'This announcement does not ask for an acknowledgement');
      if (a.reminded_at && Date.now() - new Date(a.reminded_at).getTime() < REMIND_EVERY_MS) throw Errors.conflict('reminded_recently', 'People were reminded less than an hour ago');
      const receipts = new Map((await tx.collection('announcement_receipts').find({ announcement_id: id })).map((r) => [r.membership_id as string, r]));
      const pending = (await this.audience(tx, a)).filter((m) => !ackCurrent(a, receipts.get(m)));
      await tx.collection('announcements').updateOne({ id }, { $set: { reminded_at: new Date() } });
      await this.notifications.notify(tx, {
        membershipIds: pending, kind: 'announcement.reminder', title: `Reminder: please read and acknowledge "${a.title}"`, link: link(id),
        priority: NOTICE_PRIORITY[(a.priority ?? 'normal') as AnnouncementPriority], dedupeKey: `announcement-reminder:${id}`,
      });
      await this.audit.record(tx, { action: 'announcement.reminded', resourceType: 'announcement', resourceId: id, metadata: { people: pending.length } });
      return { reminded: pending.length };
    });
  }

  async archive(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      if (!(await tx.collection('announcements').updateOne({ id, status: 'published', deleted_at: null }, { $set: { status: 'archived', pinned: false } }))) throw Errors.conflict('not_published', 'Only published announcements can be archived');
      await this.audit.record(tx, { action: 'announcement.archived', resourceType: 'announcement', resourceId: id });
      return { id };
    });
  }

  /**
   * Deletes an announcement. A draft or scheduled one is removed; a published or archived one leaves every feed but
   * stays on record with its read receipts and acknowledgements (HR can still list deleted ones).
   */
  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('announcements:manage', undefined, tx);
      const s = await this.authz.subject(tx);
      const a = await tx.collection('announcements').findOne({ id, deleted_at: null });
      if (!a) throw Errors.notFound('Announcement');
      if (a.status === 'draft' || a.status === 'scheduled') {
        await tx.collection('announcements').deleteOne({ id });
        return;
      }
      await tx.collection('announcements').updateOne({ id }, { $set: { deleted_at: new Date(), deleted_by_membership_id: s.membershipId, status: 'archived', pinned: false } });
      // Its notifications are cleared, and open feeds drop it.
      const people = await tx.collection('notifications').distinct<string>('membership_id', { link: link(id), read_at: null });
      await tx.collection('notifications').update({ link: link(id), read_at: null }, { $set: { read_at: new Date() } });
      await this.notifications.signal(tx, people, 'notifications.read');
      await this.notifications.signal(tx, await this.audience(tx, a), 'announcements.changed', { announcementId: id });
      await this.audit.record(tx, { action: 'announcement.deleted', resourceType: 'announcement', resourceId: id, metadata: { title: a.title, status: a.status } });
    });
  }
}
