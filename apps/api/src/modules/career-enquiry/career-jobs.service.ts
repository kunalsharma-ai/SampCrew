import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { CAREER_INTERVIEW_TYPES, careerLabel } from '@crew/contracts';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { NotificationService } from '../../platform/notify/notification.service';

/**
 * Interview reminders for Career Enquiry: an hour before, the interviewer and the assigned HR and recruiter get a
 * notice (bell, and whatever channels each chose). Each interview is reminded once (rescheduling sends it again).
 * Follow-up reminders go through the Candidate CRM's own job, which links Career Enquiry follow-ups back here.
 */
@Injectable()
export class CareerJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CareerJobs');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    this.timer = setInterval(() => void this.runAll().catch((err: Error) => this.logger.error(`Career interview reminders failed: ${err.message}`)), 60_000);
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
      release = await this.db.tryLease('career_reminders', 55_000);
      if (!release) return 0;
      const due = await this.db.platform((tx) => tx.collection('career_interviews').find(
        { status: 'scheduled', reminded_at: null, starts_at: { $gt: now, $lte: new Date(now.getTime() + 3_600_000) } }, { projection: { tenant_id: 1 }, limit: 500 },
      ));
      let sent = 0;
      for (const t of new Set(due.map((d) => d.tenant_id as string))) sent += await this.runTenant(t, now).catch(() => 0);
      return sent;
    } finally {
      if (release) await release().catch(() => undefined);
      this.running = false;
    }
  }

  async runTenant(tenantId: string, now = new Date()) {
    return this.db.tenant(async (tx) => {
      let sent = 0;
      for (const i of await tx.collection('career_interviews').find({ status: 'scheduled', reminded_at: null, starts_at: { $gt: now, $lte: new Date(now.getTime() + 3_600_000) } }, { limit: 500 })) {
        const app = await tx.collection('career_applications').findOne({ id: i.application_id }, { projection: { assigned_hr_membership_id: 1, assigned_recruiter_membership_id: 1, code: 1 } });
        const c = await tx.collection('candidates').findOne({ id: i.candidate_id }, { projection: { first_name: 1, last_name: 1 } });
        const mins = Math.max(1, Math.round((new Date(i.starts_at).getTime() - now.getTime()) / 60_000));
        const to = [...new Set([i.interviewer_membership_id, app?.assigned_hr_membership_id, app?.assigned_recruiter_membership_id].filter(Boolean))] as string[];
        if (to.length) {
          sent += await this.notifications.notify(tx, {
            membershipIds: to, kind: 'career.interview_reminder', priority: 'high', title: `Interview with ${`${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim()} in ${mins} minutes`,
            body: [app?.code, careerLabel(CAREER_INTERVIEW_TYPES, i.type), i.meeting_link ?? i.location].filter(Boolean).join(' · '),
            link: `/career-enquiry/applications/${i.application_id}?tab=interviews`, dedupeKey: `career.interview_reminder:${i.id}:${new Date(i.starts_at).toISOString()}`,
          });
        }
        await tx.collection('career_interviews').updateOne({ id: i.id }, { $set: { reminded_at: now } });
      }
      return sent;
    }, { tenantId });
  }
}
