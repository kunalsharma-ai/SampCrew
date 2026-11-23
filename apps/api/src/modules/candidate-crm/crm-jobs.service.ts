import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { crmLabel, FOLLOW_UP_TYPES } from '@crew/contracts';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { candidateName } from '../recruitment/recruitment-common';
import { dayBounds, type Doc, tenantZone } from './crm-common';

/**
 * Follow-up reminders, through the notification bell (and whatever channels each person chose): a reminder the
 * chosen number of minutes before, a notice when it is due, and one overdue notice the next day. Each goes out once
 * (the follow-up records when). Runs every minute on one API server at a time.
 */
@Injectable()
export class CrmJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CrmJobs');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    const tick = () => void this.runAll().catch((err: Error) => this.logger.error(`Candidate CRM reminders failed: ${err.message}`));
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll(now = new Date()) {
    if (this.running) return 0;
    this.running = true;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.db.tryLease('crm_reminders', 55_000);
      if (!release) return 0;
      const tenants = await this.db.platform((tx) => tx.collection('tenants').find({ status: 'active' }, { projection: { id: 1 } }));
      let sent = 0;
      for (const t of tenants) {
        try {
          sent += await this.runTenant(t.id as string, now);
        } catch (err) {
          this.logger.error(`Candidate CRM reminders failed for tenant ${t.id}: ${(err as Error).message}`);
        }
      }
      return sent;
    } finally {
      if (release) await release().catch(() => undefined);
      this.running = false;
    }
  }

  /** Sends the reminders that are due for one company; returns how many notices went out. */
  async runTenant(tenantId: string, now = new Date()) {
    return this.db.tenant(async (tx) => {
      const ups = tx.collection('candidate_follow_ups');
      const open = { status: { $in: ['pending', 'rescheduled'] }, assigned_membership_id: { $ne: null } };
      if (!(await ups.exists({ ...open, due_at: { $lt: new Date(now.getTime() + 7 * 86_400_000) }, $or: [{ reminded_at: null }, { due_notified_at: null }, { overdue_notified_at: null }] }))) return 0;
      const { start } = dayBounds(await tenantZone(tx), now);
      const names = new Map<string, Doc>();
      const cand = async (id: string) => {
        if (!names.has(id)) names.set(id, (await tx.collection('candidates').findOne({ id }, { projection: { first_name: 1, last_name: 1, candidate_code: 1, crm_archived_at: 1, anonymized_at: 1 } })) ?? {});
        return names.get(id)!;
      };
      let sent = 0;
      const notice = async (f: Doc, kind: string, title: string, priority: 'normal' | 'high') => {
        const c = await cand(f.candidate_id);
        if (c.anonymized_at || c.crm_archived_at) return;
        sent += await this.notifications.notify(tx, {
          membershipIds: [f.assigned_membership_id], kind, priority, title: title.replace('{name}', candidateName(c) || 'a candidate'),
          body: [crmLabel(FOLLOW_UP_TYPES, f.type), c.candidate_code, f.reason].filter(Boolean).join(' · '),
          link: `/recruitment/crm/candidates/${f.candidate_id}?tab=follow-ups`, dedupeKey: `${kind}:${f.id}`, resource: { type: 'candidate', id: f.candidate_id },
        });
      };
      // Reminders before the time.
      for (const f of await ups.find({ ...open, reminded_at: null, reminder_minutes: { $gt: 0 }, due_at: { $gt: now, $lt: new Date(now.getTime() + 7 * 86_400_000) } }, { limit: 500 })) {
        if (new Date(f.due_at).getTime() - f.reminder_minutes * 60_000 > now.getTime()) continue;
        const mins = Math.max(1, Math.round((new Date(f.due_at).getTime() - now.getTime()) / 60_000));
        await notice(f, 'candidate.follow_up_reminder', `Follow-up with {name} in ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}`, f.priority === 'urgent' ? 'high' : 'normal');
        await ups.updateOne({ id: f.id }, { $set: { reminded_at: now } });
      }
      // Due now.
      for (const f of await ups.find({ ...open, due_notified_at: null, due_at: { $lte: now, $gte: start } }, { limit: 500 })) {
        await notice(f, 'candidate.follow_up_due', 'Follow-up with {name} is due now', f.priority === 'urgent' || f.priority === 'high' ? 'high' : 'normal');
        await ups.updateOne({ id: f.id }, { $set: { due_notified_at: now, reminded_at: f.reminded_at ?? now } });
      }
      // Overdue: still open after the day it was due.
      for (const f of await ups.find({ ...open, overdue_notified_at: null, due_at: { $lt: start } }, { limit: 500 })) {
        await notice(f, 'candidate.follow_up_overdue', 'Overdue follow-up with {name}', 'high');
        await ups.updateOne({ id: f.id }, { $set: { overdue_notified_at: now, due_notified_at: f.due_notified_at ?? now, reminded_at: f.reminded_at ?? now } });
      }
      return sent;
    }, { tenantId });
  }
}
