import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { AttendanceService } from '../attendance/attendance.service';
import { DevicesService } from '../attendance/devices.service';
import { EmployeesService } from '../employees/employees.service';
import { LeaveService } from '../leave/leave.service';
import { HelpdeskService } from '../helpdesk/helpdesk.service';
import { CandidatesService } from '../recruitment/candidates.service';
import { AiService } from '../ai/ai.service';
import { InsightsService } from '../insights/insights.service';
import { PrivacyService } from '../privacy/privacy.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';

export interface HrJobResult {
  tenantId: string;
  placementsUpdated: number;
  joinersStarted: number;
  exitsCompleted: number;
  accrualsPosted: number;
  attendanceDaysComputed: number;
  devicesAlerted: number;
  candidatesAnonymized: number;
  helpdeskCasesClosed: number;
  attritionScored: number;
  aiPromptsPurged: number;
  retentionApplied: boolean;
}

/**
 * Time-based HR changes: future-dated job changes take effect, joiners start, exits complete (logins are
 * suspended) and leave accrues. Every step is idempotent, so the job runs hourly and on start-up, and a
 * missed run is caught up by the next one.
 */
@Injectable()
export class HrJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('HrJobs');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly employees: EmployeesService,
    private readonly leave: LeaveService,
    private readonly attendance: AttendanceService,
    private readonly devices: DevicesService,
    private readonly candidates: CandidatesService,
    private readonly helpdesk: HelpdeskService,
    private readonly ai: AiService,
    private readonly insights: InsightsService,
    private readonly privacy: PrivacyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    const tick = () => void this.runAll().catch((err: Error) => this.logger.error(`HR job failed: ${err.message}`));
    setTimeout(tick, 5_000).unref();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll(asOf = new Date().toISOString().slice(0, 10)): Promise<HrJobResult[]> {
    if (this.running) return [];
    this.running = true;
    // With several API servers, only one runs the daily jobs at a time: a lease held for the whole run (and dropped
    // after an hour if that server dies). Another server that finds it taken skips this tick.
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.db.tryLease('hr_jobs', 60 * 60 * 1000);
      if (!release) {
        this.logger.log('HR jobs are already running on another server; skipping this run');
        return [];
      }
      const tenants = await this.db.platform((tx) => tx.collection('tenants').find({ status: 'active' }, { projection: { id: 1 } }));
      const out: HrJobResult[] = [];
      for (const t of tenants) {
        try {
          out.push(await this.runTenant(t.id as string, asOf));
        } catch (err) {
          this.logger.error(`HR job failed for tenant ${t.id}: ${(err as Error).message}`);
        }
      }
      return out;
    } finally {
      if (release) await release().catch(() => undefined);
      this.running = false;
    }
  }

  async runTenant(tenantId: string, asOf: string): Promise<HrJobResult> {
    const hr = await this.db.tenant(async (tx) => {
      const placementsUpdated = await this.employees.applyCurrent(tx, asOf);
      const joinersStarted = await this.employees.startJoiners(tx, asOf);
      const exitsCompleted = await this.employees.finaliseExits(tx, asOf);
      const accrualsPosted = await this.leave.runAccruals(tx, asOf);
      return { tenantId, placementsUpdated, joinersStarted, exitsCompleted, accrualsPosted };
    }, { tenantId });
    // Attendance runs in its own transactions so a problem there never holds back the HR changes above.
    const attendanceDaysComputed = await this.attendance.refreshRecent(tenantId);
    const devicesAlerted = await this.devices.alertOffline(tenantId);
    // Candidate data past the career site's retention period is anonymised (recruitment entitlement or not:
    // data a workspace already holds still has to age out after a downgrade).
    const candidatesAnonymized = await this.candidates.applyRetention(tenantId);
    // Resolved helpdesk cases the person neither confirmed nor reopened close after 7 days.
    const helpdeskCasesClosed = await this.db.tenant((tx) => this.helpdesk.autoClose(tx), { tenantId });
    // Attrition scores, once a day (the job runs hourly; a second run on the same day only refreshes them).
    const attritionScored = await this.db.tenant(async (tx) => {
      if (!(await loadEntitlements(tx)).features.has('workforce_analytics')) return 0;
      if (await tx.collection('attrition_scores').exists({ computed_on: asOf })) return 0;
      return this.insights.computeAttrition(tx, asOf);
    }, { tenantId });
    // AI prompt and answer text past the workspace's retention period is removed; usage numbers stay.
    const aiPromptsPurged = await this.db.tenant((tx) => this.ai.purgeExpired(tx), { tenantId });
    // The workspace's retention schedule (leavers, exports, sign-in logs), once a day.
    const retentionApplied = Boolean(await this.privacy.applyRetentionDaily(tenantId));
    return { ...hr, attendanceDaysComputed, devicesAlerted, candidatesAnonymized, helpdeskCasesClosed, attritionScored, aiPromptsPurged, retentionApplied };
  }
}
