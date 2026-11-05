import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { EmployeesService } from '../employees/employees.service';
import { LeaveService } from '../leave/leave.service';

export interface HrJobResult {
  tenantId: string;
  placementsUpdated: number;
  joinersStarted: number;
  exitsCompleted: number;
  accrualsPosted: number;
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
    try {
      const tenants = await this.db.platform((tx) => many<{ id: string }>(tx, `select id from tenants where status = 'active'`));
      const out: HrJobResult[] = [];
      for (const t of tenants) {
        try {
          out.push(await this.runTenant(t.id, asOf));
        } catch (err) {
          this.logger.error(`HR job failed for tenant ${t.id}: ${(err as Error).message}`);
        }
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  runTenant(tenantId: string, asOf: string): Promise<HrJobResult> {
    return this.db.tenant(async (tx) => {
      const placementsUpdated = (await one<{ n: number }>(tx, 'select employees_apply_current($1::date) as n', [asOf]))!.n;
      const joinersStarted = await this.employees.startJoiners(tx, asOf);
      const exitsCompleted = await this.employees.finaliseExits(tx, asOf);
      const accrualsPosted = await this.leave.runAccruals(tx, asOf);
      return { tenantId, placementsUpdated, joinersStarted, exitsCompleted, accrualsPosted };
    }, { tenantId });
  }
}
