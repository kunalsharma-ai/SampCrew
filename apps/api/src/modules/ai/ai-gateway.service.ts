import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_FEATURE_LABEL, type AiFeature, creditsFor, redact, redactionCount } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { AppError, Errors } from '../../platform/http/errors';
import { HttpStatus } from '@nestjs/common';
import { type AiProvider, ProviderError, providerFor } from './ai-provider';

export interface Evidence { kind: string; id: string; title: string }

export interface CompleteInput {
  feature: AiFeature;
  promptVersion: string;
  system: string;
  user: string;
  evidence: Evidence[];
  subject?: { type: string; id: string };
  maxTokens?: number;
}

export interface CompleteResult { interactionId: string; text: string; model: string }

export interface AiSettingsRow { features: Partial<Record<AiFeature, boolean>>; prompt_log_days: number }

/**
 * The only way CREW talks to an AI model. It checks that AI is set up and the feature is switched on for the
 * workspace, keeps the workspace within its monthly AI credits, removes personal identifiers from everything it
 * sends, and records each call (what was sent, the answer, the sources, tokens, credits and time) in
 * ai_interactions. No database transaction is held open while the model answers.
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger('AiGateway');
  private provider: AiProvider | null;

  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.provider = providerFor(config);
  }

  /** For tests: swap the provider (for example to point at a local stub server). */
  setProvider(p: AiProvider | null) {
    this.provider = p;
  }

  get configured() {
    return this.provider !== null;
  }

  get providerInfo() {
    return this.provider ? { provider: this.provider.name, model: this.provider.model } : { provider: 'none', model: '' };
  }

  async settings(tx: Tx): Promise<AiSettingsRow> {
    return (await one<AiSettingsRow>(tx, 'select features, prompt_log_days from ai_settings')) ?? { features: {}, prompt_log_days: 90 };
  }

  /** Credits used this calendar month (UTC) and the plan's monthly allowance (-1: unlimited). */
  async usage(tx: Tx): Promise<{ used: number; limit: number }> {
    const r = await one<{ used: number }>(tx, `select coalesce(sum(credits), 0)::int as used from ai_interactions where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`);
    const e = await this.entitlements.current(tx);
    return { used: r!.used, limit: e.limits.ai_credits_monthly ?? 0 };
  }

  /** Whether a feature can be used right now, and why not. */
  async availability(tx: Tx, feature: AiFeature): Promise<{ available: boolean; reason: string | null }> {
    if (!this.provider) return { available: false, reason: 'AI is not set up for this CREW installation.' };
    const e = await this.entitlements.current(tx);
    if (!e.features.has('ai_copilot')) return { available: false, reason: 'Your plan does not include CREW AI.' };
    const s = await this.settings(tx);
    if (!s.features[feature]) return { available: false, reason: 'Your workspace has not switched this AI feature on.' };
    const u = await this.usage(tx);
    if (u.limit !== -1 && u.used >= u.limit) return { available: false, reason: 'Your workspace has used this month\'s AI credits.' };
    return { available: true, reason: null };
  }

  private async record(tx: Tx, row: {
    feature: AiFeature; status: string; promptVersion: string; model: string; subject?: { type: string; id: string };
    request: unknown; response: string | null; evidence: Evidence[]; redactions: Record<string, number>;
    inputTokens?: number; outputTokens?: number; credits?: number; latencyMs?: number; error?: string | null;
  }): Promise<string> {
    const actor = requestContext.tenantActor();
    const r = await one<{ id: string }>(
      tx,
      `insert into ai_interactions (tenant_id, membership_id, feature, status, provider, model, prompt_version, subject_type, subject_id, request, response,
                                    evidence, redactions, input_tokens, output_tokens, credits, latency_ms, error)
       values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
      [actor.membershipId, row.feature, row.status, this.provider?.name ?? 'none', row.model, row.promptVersion, row.subject?.type ?? null, row.subject?.id ?? null,
        row.request === null ? null : JSON.stringify(row.request), row.response, JSON.stringify(row.evidence), JSON.stringify(row.redactions),
        row.inputTokens ?? 0, row.outputTokens ?? 0, row.credits ?? 0, row.latencyMs ?? 0, row.error ?? null],
    );
    await this.audit.record(tx, { action: 'ai.called', resourceType: 'ai_interaction', resourceId: r!.id, metadata: { feature: row.feature, status: row.status, credits: row.credits ?? 0 } });
    return r!.id;
  }

  /** Throws the reason a feature cannot be used right now (not set up, not in the plan, switched off). */
  async assertAvailable(feature: AiFeature) {
    await this.db.tenant(async (tx) => {
      if (!this.provider) throw Errors.conflict('ai_not_configured', 'AI is not set up for this CREW installation. An administrator can set an AI provider; until then CREW does not send data to any AI service.');
      const e = await this.entitlements.current(tx);
      if (!e.features.has('ai_copilot')) throw Errors.featureNotInPlan('CREW AI Copilots');
      const s = await this.settings(tx);
      if (!s.features[feature]) throw Errors.conflict('ai_feature_off', `This AI feature is switched off for your workspace (${AI_FEATURE_LABEL[feature].split(':')[0]}).`);
    });
  }

  /** Records an answer CREW gave without calling a model (for example: no help article matched). */
  async recordWithoutModel(input: { feature: AiFeature; promptVersion: string; question: string; response: string; subject?: { type: string; id: string } }) {
    return this.db.tenant(async (tx) => {
      const q = redact(input.question);
      return this.record(tx, { feature: input.feature, status: 'no_sources', promptVersion: input.promptVersion, model: '', subject: input.subject, request: { user: q.text }, response: input.response, evidence: [], redactions: q.removed });
    });
  }

  async complete(input: CompleteInput): Promise<CompleteResult> {
    const provider = this.provider;
    const sys = redact(input.system);
    const usr = redact(input.user);
    const removed: Record<string, number> = { ...sys.removed };
    for (const [k, v] of Object.entries(usr.removed)) removed[k] = (removed[k] ?? 0) + (v ?? 0);
    const request = { system: sys.text, user: usr.text, maxTokens: input.maxTokens ?? 1024 };

    // 1. Checks, in their own short transaction.
    await this.db.tenant(async (tx) => {
      if (!provider) throw Errors.conflict('ai_not_configured', 'AI is not set up for this CREW installation. An administrator can set an AI provider; until then CREW does not send data to any AI service.');
      const e = await this.entitlements.current(tx);
      if (!e.features.has('ai_copilot')) throw Errors.featureNotInPlan('CREW AI Copilots');
      const s = await this.settings(tx);
      if (!s.features[input.feature]) throw Errors.conflict('ai_feature_off', `This AI feature is switched off for your workspace (${AI_FEATURE_LABEL[input.feature].split(':')[0]}).`);
      const u = await this.usage(tx);
      if (u.limit !== -1 && u.used >= u.limit) {
        await this.record(tx, { feature: input.feature, status: 'over_limit', promptVersion: input.promptVersion, model: provider.model, subject: input.subject, request: null, response: null, evidence: [], redactions: {} });
        throw new AppError(HttpStatus.PAYMENT_REQUIRED, 'ai_credits_used', `Your workspace has used its ${u.limit} AI credits for this month. They renew on the 1st.`);
      }
    });

    // 2. The model call, outside any transaction.
    const started = Date.now();
    let status = 'ok';
    let text = '';
    let model = provider!.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let error: string | null = null;
    try {
      const r = await provider!.complete(request);
      ({ text, model, inputTokens, outputTokens } = r);
      if (r.refused) status = 'refused';
      else if (!text) { status = 'error'; error = 'The model returned no text'; }
    } catch (err) {
      status = 'error';
      error = err instanceof ProviderError ? err.message : 'Unexpected error calling the AI provider';
      if (!(err instanceof ProviderError)) this.logger.error(`AI call failed: ${(err as Error).message}`);
    }
    const latencyMs = Date.now() - started;
    const credits = status === 'error' && !inputTokens ? 0 : creditsFor(inputTokens, outputTokens);

    // 3. The record, in a second transaction.
    const interactionId = await this.db.tenant((tx) =>
      this.record(tx, {
        feature: input.feature, status, promptVersion: input.promptVersion, model, subject: input.subject, request, response: text || null,
        evidence: input.evidence, redactions: removed, inputTokens, outputTokens, credits, latencyMs, error,
      }),
    );
    if (status === 'refused') throw Errors.conflict('ai_refused', 'The AI declined to answer this. Ask HR directly instead.');
    if (status === 'error') throw Errors.unavailable('ai_unavailable', `${error}. Try again in a minute, or ask HR directly.`);
    if (redactionCount(removed)) this.logger.log(`Removed ${redactionCount(removed)} identifiers from an AI prompt (${input.feature})`);
    return { interactionId, text, model };
  }
}
