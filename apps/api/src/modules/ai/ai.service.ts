import { Injectable } from '@nestjs/common';
import { AI_FEATURES, type AiFeature, type AiFeedbackInput, type AiSettingsInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { memberNames } from '../employees/employee-view';
import { Errors } from '../../platform/http/errors';
import { AiGatewayService, monthStart } from './ai-gateway.service';


/** AI settings, usage, the prompt log for auditors, feedback, and removal of old prompt text. */
@Injectable()
export class AiService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: AiGatewayService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** What the signed-in person can use. Shown to everyone so the UI only offers what works. */
  async status() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const features: Record<string, { available: boolean; reason: string | null }> = {};
      for (const f of AI_FEATURES) features[f] = await this.gateway.availability(tx, f);
      return { ...(await this.gateway.providerInfo()), canUse: hasPermission(s, 'ai:use').allowed, features };
    });
  }

  async getSettings() {
    return this.db.tenant(async (tx) => {
      const s = await this.gateway.settings(tx);
      const usage = await this.gateway.usage(tx);
      return {
        ...(await this.gateway.providerInfo()),
        features: Object.fromEntries(AI_FEATURES.map((f) => [f, Boolean(s.features[f])])) as Record<AiFeature, boolean>,
        promptLogDays: s.prompt_log_days,
        usage,
      };
    });
  }

  async updateSettings(input: AiSettingsInput) {
    await this.db.tenant(async (tx) => {
      const before = await this.gateway.settings(tx);
      const actor = requestContext.tenantActor();
      const values = { features: input.features, prompt_log_days: input.promptLogDays, updated_by_membership_id: actor.membershipId };
      await tx.collection('ai_settings').upsert({}, values, { $set: { ...values, updated_at: new Date() } });
      await this.audit.record(tx, {
        action: 'ai.settings_changed', resourceType: 'ai_settings', resourceId: actor.tenantId,
        changes: { before: { features: before.features, promptLogDays: before.prompt_log_days }, after: { features: input.features, promptLogDays: input.promptLogDays } },
      });
    });
    return this.getSettings();
  }

  /** Credits and calls this month, by feature and by day. */
  async usageReport() {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('ai_interactions').find({ created_at: { $gte: monthStart() } }, {
        projection: { feature: 1, status: 1, credits: 1, input_tokens: 1, output_tokens: 1, latency_ms: 1, helpful: 1 },
      });
      const group = <K extends string>(key: (r: (typeof rows)[number]) => K) => {
        const m = new Map<K, typeof rows>();
        for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
        return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      };
      const sumOf = (rs: typeof rows, f: string) => rs.reduce((a, r) => a + Number(r[f] ?? 0), 0);
      const byFeature = group((r) => r.feature as string).map(([feature, rs]) => {
        const ok = rs.filter((r) => r.status === 'ok');
        return {
          feature, calls: rs.length, credits: sumOf(rs, 'credits'), inputTokens: sumOf(rs, 'input_tokens'), outputTokens: sumOf(rs, 'output_tokens'),
          avgLatencyMs: ok.length ? Math.round(sumOf(ok, 'latency_ms') / ok.length) : 0,
          helpful: rs.filter((r) => r.helpful === true).length, notHelpful: rs.filter((r) => r.helpful === false).length,
        };
      });
      const byStatus = group((r) => r.status as string).map(([status, rs]) => ({ status, calls: rs.length }));
      return { ...(await this.gateway.usage(tx)), byFeature, byStatus };
    });
  }

  async interactions(q: { feature?: string; status?: string; limit: number }) {
    return this.db.tenant(async (tx) => {
      const docs = await tx.collection('ai_interactions').find({ ...(q.feature ? { feature: q.feature } : {}), ...(q.status ? { status: q.status } : {}) }, { sort: { created_at: -1 }, limit: q.limit });
      const names = await memberNames(tx, docs.map((i) => i.membership_id));
      return docs.map((i) => ({
        id: i.id, createdAt: i.created_at, feature: i.feature, status: i.status, model: i.model, promptVersion: i.prompt_version, credits: i.credits,
        inputTokens: i.input_tokens, outputTokens: i.output_tokens, latencyMs: i.latency_ms, helpful: i.helpful ?? null, subjectType: i.subject_type ?? null,
        byName: names.get(i.membership_id) ?? null, purged: !!i.purged_at, sourceCount: (i.evidence as unknown[]).length,
      }));
    });
  }

  /** The full record of one call. Reading it is itself audited. */
  async interaction(id: string) {
    return this.db.tenant(async (tx) => {
      const i = await tx.collection('ai_interactions').findOne({ id });
      const names = i ? await memberNames(tx, [i.membership_id]) : new Map();
      const r = i && {
        id: i.id, createdAt: i.created_at, feature: i.feature, status: i.status, provider: i.provider, model: i.model, promptVersion: i.prompt_version,
        request: i.request ?? null, response: i.response ?? null, evidence: i.evidence, redactions: i.redactions, inputTokens: i.input_tokens, outputTokens: i.output_tokens,
        credits: i.credits, latencyMs: i.latency_ms, error: i.error ?? null, helpful: i.helpful ?? null, feedback: i.feedback ?? null, purgedAt: i.purged_at ?? null,
        subjectType: i.subject_type ?? null, subjectId: i.subject_id ?? null, byName: names.get(i.membership_id) ?? null,
      };
      if (!r) throw Errors.notFound('AI interaction');
      await this.audit.record(tx, { action: 'ai.interaction_viewed', resourceType: 'ai_interaction', resourceId: id });
      return r;
    });
  }

  async feedback(id: string, input: AiFeedbackInput) {
    return this.db.tenant(async (tx) => {
      const actor = requestContext.tenantActor();
      const r = await tx.collection<{ membership_id: string; status: string }>('ai_interactions').findOne({ id });
      if (!r || r.membership_id !== actor.membershipId) throw Errors.notFound('AI answer');
      await tx.collection('ai_interactions').updateOne({ id }, { $set: { helpful: input.helpful, feedback: input.comment || null, feedback_at: new Date() } });
      return { ok: true };
    });
  }

  /** Removes prompt and answer text older than the workspace's retention period. Usage numbers stay. */
  async purgeExpired(tx: TenantTx): Promise<number> {
    const days = ((await tx.collection('ai_settings').findOne({}))?.prompt_log_days as number | undefined) ?? 90;
    return tx.collection('ai_interactions').update(
      { purged_at: null, created_at: { $lt: new Date(Date.now() - days * 86_400_000) } },
      { $set: { request: null, response: null, purged_at: new Date() } },
    );
  }
}
