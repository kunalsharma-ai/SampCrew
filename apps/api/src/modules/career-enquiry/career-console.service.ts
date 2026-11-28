import { Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { CareerSyncService } from './career-sync.service';

/**
 * The Console's view of Career Enquiry: which companies have connected a website, whether applications are arriving,
 * and what is failing, so SAMPLEDGE can help. It reads counts and states only; candidate details stay with the company.
 */
@Injectable()
export class CareerConsoleService {
  constructor(private readonly db: DatabaseService, private readonly sync: CareerSyncService, private readonly audit: AuditService) {}

  async list() {
    return this.db.platform(async (tx) => {
      const integs = await tx.collection('career_integrations').find({}, { sort: { created_at: 1 } });
      const tenants = new Map((await tx.collection('tenants').find({ id: { $in: integs.map((i) => i.tenant_id) } }, { projection: { name: 1, status: 1, slug: 1 } })).map((t) => [t.id as string, t]));
      const week = new Date(Date.now() - 7 * 86_400_000);
      const rows = [];
      for (const i of integs) {
        const jobs = tx.collection('career_sync_jobs');
        const apps = tx.collection('career_applications');
        rows.push({
          tenantId: i.tenant_id as string, company: (tenants.get(i.tenant_id)?.name as string | undefined) ?? 'Company', companyStatus: (tenants.get(i.tenant_id)?.status as string | undefined) ?? 'unknown',
          websiteName: i.website_name as string, websiteUrl: i.website_url as string, enabled: !!i.enabled, connected: !!i.api_key_hash, statusUpdates: !!i.send_status_updates,
          lastReceivedAt: i.last_received_at ?? null, lastSuccessAt: i.last_success_at ?? null, lastError: i.last_error ?? null, lastErrorAt: i.last_error_at ?? null,
          received7d: await apps.count({ tenant_id: i.tenant_id, created_at: { $gt: week } }), total: await apps.count({ tenant_id: i.tenant_id }),
          failed: await jobs.count({ tenant_id: i.tenant_id, status: 'failed' }), pending: await jobs.count({ tenant_id: i.tenant_id, status: { $in: ['pending', 'running'] } }),
          lastTest: i.last_test ?? null,
        });
      }
      return {
        rows,
        totals: { companies: rows.length, connected: rows.filter((r) => r.connected).length, failing: rows.filter((r) => r.failed > 0).length, received7d: rows.reduce((s, r) => s + r.received7d, 0) },
      };
    });
  }

  async retry(tenantId: string) {
    const exists = await this.db.platform((tx) => tx.collection('career_integrations').exists({ tenant_id: tenantId }));
    if (!exists) throw Errors.notFound('Career integration');
    const r = await this.sync.retry(tenantId);
    await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.career_sync_retried', resourceType: 'tenant', resourceId: tenantId, metadata: r }));
    return r;
  }
}
