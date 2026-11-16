import { PLATFORM_INTEGRATION_INPUTS, PLATFORM_INTEGRATION_SECRETS, type PlatformIntegrationKey } from '@crew/contracts';

/** One integration as an older SampCrew release read it from environment variables. */
export interface LegacyIntegration {
  key: PlatformIntegrationKey;
  /** The variables it came from (the lines to delete). */
  variables: string[];
  enabled: boolean;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  /** True when the variables only repeat what SampCrew does anyway (MOBILE_SSO_REDIRECTS=crew://sso). */
  sameAsDefault: boolean;
}

/**
 * Reads the integration variables older releases used (SMTP_URL, ANTHROPIC_API_KEY, EXPO_*, CLAMAV_URL,
 * MOBILE_SSO_REDIRECTS and friends), only so they can be moved into the database once. Values are checked with the
 * same rules as the Console; a value that fails is reported in `problems` and not moved.
 */
export function legacyIntegrations(env: NodeJS.ProcessEnv, productionLike: boolean): { items: LegacyIntegration[]; problems: string[] } {
  const get = (k: string) => (env[k] ?? '').trim();
  const present = (...names: string[]) => names.filter((n) => get(n));
  const items: LegacyIntegration[] = [];
  const problems: string[] = [];
  const add = (key: PlatformIntegrationKey, variables: string[], input: Record<string, unknown>, sameAsDefault = false) => {
    const parsed = PLATFORM_INTEGRATION_INPUTS[key].safeParse(input);
    if (!parsed.success) {
      problems.push(`${variables.join(', ')}: ${parsed.error.issues.map((i) => `${i.path.join('.') || key} ${i.message}`).join('; ')}.`);
      return;
    }
    const { enabled, ...rest } = parsed.data as Record<string, unknown> & { enabled: boolean };
    const settings: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === '') continue;
      if (PLATFORM_INTEGRATION_SECRETS[key].includes(k)) secrets[k] = String(v);
      else settings[k] = v;
    }
    items.push({ key, variables, enabled, settings, secrets, sameAsDefault });
  };

  const ai = present('AI_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'AI_MODEL', 'AI_EFFORT', 'AI_REFUSAL_FALLBACK', 'AI_TIMEOUT_MS');
  if (get('ANTHROPIC_API_KEY')) {
    add('ai', ai, {
      enabled: get('AI_PROVIDER') === 'anthropic',
      apiKey: get('ANTHROPIC_API_KEY'),
      model: get('AI_MODEL') || 'claude-opus-5-5',
      effort: get('AI_EFFORT') || 'low',
      refusalFallback: get('AI_REFUSAL_FALLBACK') !== 'false',
      timeoutSeconds: Math.min(120, Math.max(5, Math.round(Number(get('AI_TIMEOUT_MS') || 30000) / 1000))),
      ...(get('ANTHROPIC_BASE_URL') ? { baseUrl: get('ANTHROPIC_BASE_URL') } : {}),
    });
  } else if (get('AI_PROVIDER') === 'anthropic') {
    problems.push('AI_PROVIDER=anthropic is set without ANTHROPIC_API_KEY.');
  }

  if (get('SMTP_URL')) {
    let u: URL | undefined;
    try {
      u = new URL(get('SMTP_URL'));
    } catch {
      problems.push('SMTP_URL is not a valid smtp:// or smtps:// address.');
    }
    if (u) {
      const tls = u.protocol === 'smtps:';
      add('email', present('SMTP_URL', 'MAIL_FROM'), {
        enabled: true,
        host: u.hostname,
        port: Number(u.port) || (tls ? 465 : 587),
        // smtp:// let the server offer STARTTLS. Staging and production require it; local test servers have none.
        security: tls ? 'tls' : productionLike ? 'starttls' : 'none',
        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        from: get('MAIL_FROM') || 'SampCrew <no-reply@crew.local>',
      });
    }
  }

  if (get('EXPO_PUSH_ENABLED') === 'true' || get('EXPO_ACCESS_TOKEN')) {
    add('push', present('EXPO_PUSH_ENABLED', 'EXPO_ACCESS_TOKEN'), { enabled: get('EXPO_PUSH_ENABLED') === 'true', ...(get('EXPO_ACCESS_TOKEN') ? { accessToken: get('EXPO_ACCESS_TOKEN') } : {}) });
  }

  if (get('CLAMAV_URL')) add('scanning', ['CLAMAV_URL'], { enabled: true, url: get('CLAMAV_URL') });

  if (get('MOBILE_SSO_REDIRECTS')) {
    const redirects = [...new Set(get('MOBILE_SSO_REDIRECTS').split(',').map((s) => s.trim()).filter(Boolean))];
    if (productionLike && redirects.some((r) => /^http:/i.test(r))) problems.push('MOBILE_SSO_REDIRECTS holds a plain http:// address, which staging and production refuse.');
    else add('mobile_sso', ['MOBILE_SSO_REDIRECTS'], { enabled: true, redirects }, redirects.length === 1 && redirects[0] === 'crew://sso');
  }
  return { items, problems };
}
