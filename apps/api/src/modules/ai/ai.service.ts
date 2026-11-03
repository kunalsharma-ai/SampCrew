import { Injectable } from '@nestjs/common';
import { AI_FEATURES, type AiFeature, type AiFeedbackInput, type AiSettingsInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { AiGatewayService } from './ai-gateway.service';

const WHO = `coalesce(nullif(trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name), ''), u.full_name)`;

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
      await tx.query(
        `insert into ai_settings (tenant_id, features, prompt_log_days, updated_by_membership_id) values (app_tenant_id(), $1, $2, $3)
         on conflict (tenant_id) do update set features = excluded.features, prompt_log_days = excluded.prompt_log_days,
                updated_by_membership_id = excluded.updated_by_membership_id, updated_at = now()`,
        [JSON.stringify(input.features), input.promptLogDays, actor.membershipId],
      );
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
      const month = `created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;
      const byFeature = await many(
        tx,
        `select feature, count(*)::int as calls, coalesce(sum(credits), 0)::int as credits, coalesce(sum(input_tokens), 0)::int as "inputTokens",
                coalesce(sum(output_tokens), 0)::int as "outputTokens", coalesce(round(avg(latency_ms) filter (where status = 'ok')), 0)::int as "avgLatencyMs",
                count(*) filter (where helpful)::int as helpful, count(*) filter (where helpful = false)::int as "notHelpful"
           from ai_interactions where ${month} group by feature order by feature`,
      );
      const byStatus = await many(tx, `select status, count(*)::int as calls from ai_interactions where ${month} group by status order by status`);
      return { ...(await this.gateway.usage(tx)), byFeature, byStatus };
    });
  }

  async interactions(q: { feature?: string; status?: string; limit: number }) {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select i.id, i.created_at as "createdAt", i.feature, i.status, i.model, i.prompt_version as "promptVersion", i.credits,
                i.input_tokens as "inputTokens", i.output_tokens as "outputTokens", i.latency_ms as "latencyMs", i.helpful,
                i.subject_type as "subjectType", ${WHO} as "byName", (i.purged_at is not null) as purged,
                jsonb_array_length(i.evidence) as "sourceCount"
           from ai_interactions i left join memberships m on m.id = i.membership_id left join users u on u.id = m.user_id
           left join employees e on e.id = m.employee_id
          where ($1::text is null or i.feature = $1) and ($2::text is null or i.status = $2)
          order by i.created_at desc limit $3`,
        [q.feature ?? null, q.status ?? null, q.limit],
      ),
    );
  }

  /** The full record of one call. Reading it is itself audited. */
  async interaction(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one<Record<string, unknown>>(
        tx,
        `select i.id, i.created_at as "createdAt", i.feature, i.status, i.provider, i.model, i.prompt_version as "promptVersion", i.request, i.response,
                i.evidence, i.redactions, i.input_tokens as "inputTokens", i.output_tokens as "outputTokens", i.credits, i.latency_ms as "latencyMs",
                i.error, i.helpful, i.feedback, i.purged_at as "purgedAt", i.subject_type as "subjectType", i.subject_id as "subjectId", ${WHO} as "byName"
           from ai_interactions i left join memberships m on m.id = i.membership_id left join users u on u.id = m.user_id
           left join employees e on e.id = m.employee_id where i.id = $1`,
        [id],
      );
      if (!r) throw Errors.notFound('AI interaction');
      await this.audit.record(tx, { action: 'ai.interaction_viewed', resourceType: 'ai_interaction', resourceId: id });
      return r;
    });
  }

  async feedback(id: string, input: AiFeedbackInput) {
    return this.db.tenant(async (tx) => {
      const actor = requestContext.tenantActor();
      const r = await one<{ membership_id: string; status: string }>(tx, 'select membership_id, status from ai_interactions where id = $1', [id]);
      if (!r || r.membership_id !== actor.membershipId) throw Errors.notFound('AI answer');
      await tx.query('update ai_interactions set helpful = $2, feedback = nullif($3, \'\'), feedback_at = now() where id = $1', [id, input.helpful, input.comment]);
      return { ok: true };
    });
  }

  /** Removes prompt and answer text older than the workspace's retention period. Usage numbers stay. */
  async purgeExpired(tx: Tx): Promise<number> {
    const r = await tx.query(
      `update ai_interactions i set request = null, response = null, purged_at = now()
        where i.purged_at is null and i.created_at < now() - make_interval(days => coalesce((select prompt_log_days from ai_settings), 90))`,
    );
    return r.rowCount ?? 0;
  }
}
