import { Injectable, Logger } from '@nestjs/common';
import { AI_FEATURE_LABEL, type AiFeature, creditsFor, redact, redactionCount } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { AppError, Errors } from '../../platform/http/errors';
import { HttpStatus } from '@nestjs/common';
import { PlatformIntegrationsService } from '../../platform/integrations/platform-integrations.service';
import { AnthropicProvider, type AiProvider, ProviderError } from './ai-provider';

/** The start of the current calendar month in UTC, from which AI credits are counted. */
export const monthStart = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

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
 * The only way SampCrew talks to an AI model. It checks that AI is set up and the feature is switched on for the
 * workspace, keeps the workspace within its monthly AI credits, removes personal identifiers from everything it
 * sends, and records each call (what was sent, the answer, the sources, tokens, credits and time) in
 * ai_interactions. No database transaction is held open while the model answers.
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger('AiGateway');
  /** Set by tests only; undefined means "use the settings in effect". */
  private override: AiProvider | null | undefined;
  private built?: { hash: string; provider: AiProvider };

  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly integrations: PlatformIntegrationsService,
  ) {}

  /** For tests: swap the provider (for example to point at a local stub server). undefined goes back to the saved settings. */
  setProvider(p: AiProvider | null | undefined) {
    this.override = p;
  }

  /**
   * The provider for the Claude API settings in effect: saved by SAMPLEDGE in the Super Admin Console (Integrations),
   * else the environment. The client is rebuilt only when those settings change.
   */
  async provider(): Promise<AiProvider | null> {
    if (this.override !== undefined) return this.override;
    const s = await this.integrations.ai();
    if (!s) return null;
    if (this.built?.hash !== s.hash) this.built = { hash: s.hash, provider: new AnthropicProvider(s) };
    return this.built.provider;
  }

  async providerInfo() {
    const p = await this.provider();
    return p ? { configured: true, provider: p.name, model: p.model } : { configured: false, provider: 'none', model: '' };
  }

  async settings(tx: TenantTx): Promise<AiSettingsRow> {
    const s = await tx.collection<AiSettingsRow>('ai_settings').findOne({});
    return s ? { features: s.features, prompt_log_days: s.prompt_log_days } : { features: {}, prompt_log_days: 90 };
  }

  /** Credits used this calendar month (UTC) and the plan's monthly allowance (-1: unlimited). */
  async usage(tx: TenantTx): Promise<{ used: number; limit: number }> {
    const [r] = await tx.collection('ai_interactions').aggregate<{ used: number }>([{ $match: { created_at: { $gte: monthStart() } } }, { $group: { _id: null, used: { $sum: '$credits' } } }]);
    const e = await this.entitlements.current(tx);
    return { used: r?.used ?? 0, limit: e.limits.ai_credits_monthly ?? 0 };
  }

  /** Whether a feature can be used right now, and why not. */
  async availability(tx: TenantTx, feature: AiFeature): Promise<{ available: boolean; reason: string | null }> {
    if (!(await this.provider())) return { available: false, reason: 'AI is not set up for this SampCrew installation.' };
    const e = await this.entitlements.current(tx);
    if (!e.features.has('ai_copilot')) return { available: false, reason: 'Your plan does not include SampCrew AI.' };
    const s = await this.settings(tx);
    if (!s.features[feature]) return { available: false, reason: 'Your workspace has not switched this AI feature on.' };
    const u = await this.usage(tx);
    if (u.limit !== -1 && u.used >= u.limit) return { available: false, reason: 'Your workspace has used this month\'s AI credits.' };
    return { available: true, reason: null };
  }

  private async record(tx: TenantTx, row: {
    provider: string; feature: AiFeature; status: string; promptVersion: string; model: string; subject?: { type: string; id: string };
    request: unknown; response: string | null; evidence: Evidence[]; redactions: Record<string, number>;
    inputTokens?: number; outputTokens?: number; credits?: number; latencyMs?: number; error?: string | null;
  }): Promise<string> {
    const actor = requestContext.tenantActor();
    const r = await tx.collection('ai_interactions').insert({
      membership_id: actor.membershipId, feature: row.feature, status: row.status, provider: row.provider, model: row.model, prompt_version: row.promptVersion,
      subject_type: row.subject?.type ?? null, subject_id: row.subject?.id ?? null, request: row.request ?? null, response: row.response, evidence: row.evidence,
      redactions: row.redactions, input_tokens: row.inputTokens ?? 0, output_tokens: row.outputTokens ?? 0, credits: row.credits ?? 0, latency_ms: row.latencyMs ?? 0, error: row.error ?? null,
    });
    await this.audit.record(tx, { action: 'ai.called', resourceType: 'ai_interaction', resourceId: r.id, metadata: { feature: row.feature, status: row.status, credits: row.credits ?? 0 } });
    return r.id as string;
  }

  /** Throws the reason a feature cannot be used right now (not set up, not in the plan, switched off). */
  async assertAvailable(feature: AiFeature) {
    const provider = await this.provider();
    await this.db.tenant(async (tx) => {
      if (!provider) throw Errors.conflict('ai_not_configured', 'AI is not set up for this SampCrew installation. SAMPLEDGE sets it up in the Super Admin Console (Integrations); until then SampCrew does not send data to any AI service.');
      const e = await this.entitlements.current(tx);
      if (!e.features.has('ai_copilot')) throw Errors.featureNotInPlan('SampCrew AI Copilots');
      const s = await this.settings(tx);
      if (!s.features[feature]) throw Errors.conflict('ai_feature_off', `This AI feature is switched off for your workspace (${AI_FEATURE_LABEL[feature].split(':')[0]}).`);
    });
  }

  /** Records an answer SampCrew gave without calling a model (for example: no help article matched). */
  async recordWithoutModel(input: { feature: AiFeature; promptVersion: string; question: string; response: string; subject?: { type: string; id: string } }) {
    return this.db.tenant(async (tx) => {
      const q = redact(input.question);
      return this.record(tx, { provider: 'none', feature: input.feature, status: 'no_sources', promptVersion: input.promptVersion, model: '', subject: input.subject, request: { user: q.text }, response: input.response, evidence: [], redactions: q.removed });
    });
  }

  async complete(input: CompleteInput): Promise<CompleteResult> {
    const provider = await this.provider();
    const sys = redact(input.system);
    const usr = redact(input.user);
    const removed: Record<string, number> = { ...sys.removed };
    for (const [k, v] of Object.entries(usr.removed)) removed[k] = (removed[k] ?? 0) + (v ?? 0);
    const request = { system: sys.text, user: usr.text, maxTokens: input.maxTokens ?? 1024 };

    // 1. Checks, in their own short transaction.
    await this.db.tenant(async (tx) => {
      if (!provider) throw Errors.conflict('ai_not_configured', 'AI is not set up for this SampCrew installation. SAMPLEDGE sets it up in the Super Admin Console (Integrations); until then SampCrew does not send data to any AI service.');
      const e = await this.entitlements.current(tx);
      if (!e.features.has('ai_copilot')) throw Errors.featureNotInPlan('SampCrew AI Copilots');
      const s = await this.settings(tx);
      if (!s.features[input.feature]) throw Errors.conflict('ai_feature_off', `This AI feature is switched off for your workspace (${AI_FEATURE_LABEL[input.feature].split(':')[0]}).`);
      const u = await this.usage(tx);
      if (u.limit !== -1 && u.used >= u.limit) {
        await this.record(tx, { provider: provider.name, feature: input.feature, status: 'over_limit', promptVersion: input.promptVersion, model: provider.model, subject: input.subject, request: null, response: null, evidence: [], redactions: {} });
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
        provider: provider!.name, feature: input.feature, status, promptVersion: input.promptVersion, model, subject: input.subject, request, response: text || null,
        evidence: input.evidence, redactions: removed, inputTokens, outputTokens, credits, latencyMs, error,
      }),
    );
    if (status === 'refused') throw Errors.conflict('ai_refused', 'The AI declined to answer this. Ask HR directly instead.');
    if (status === 'error') throw Errors.unavailable('ai_unavailable', `${error}. Try again in a minute, or ask HR directly.`);
    if (redactionCount(removed)) this.logger.log(`Removed ${redactionCount(removed)} identifiers from an AI prompt (${input.feature})`);
    return { interactionId, text, model };
  }
}
