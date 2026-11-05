import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../../platform/config/config';

export interface ProviderRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The model that actually answered (it can differ from the configured one after a fallback). */
  model: string;
  refused: boolean;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly retryable: boolean) {
    super(message);
  }
}

/** One interface per provider. Only the Claude API is implemented in this release. */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly config: AppConfig) {
    this.model = config.AI_MODEL;
    this.client = new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      // Only the configured key is used, never other credentials found in the environment.
      authToken: null,
      baseURL: config.ANTHROPIC_BASE_URL,
      timeout: config.AI_TIMEOUT_MS,
      // The SDK retries 408/409/429/5xx and connection errors with back-off.
      maxRetries: 2,
    });
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    try {
      const fallback = this.config.AI_REFUSAL_FALLBACK === 'true';
      const msg = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { effort: this.config.AI_EFFORT },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
      return {
        text,
        inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens,
        model: msg.model,
        refused: msg.stop_reason === 'refusal',
      };
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionError) throw new ProviderError('The AI provider could not be reached', null, true);
      if (err instanceof Anthropic.APIError) {
        const status = typeof err.status === 'number' ? err.status : null;
        throw new ProviderError(`The AI provider returned an error${status ? ` (${status})` : ''}`, status, status === 429 || (status ?? 0) >= 500);
      }
      throw err;
    }
  }
}

export function providerFor(config: AppConfig): AiProvider | null {
  if (config.AI_PROVIDER === 'anthropic' && config.ANTHROPIC_API_KEY) return new AnthropicProvider(config);
  return null;
}
