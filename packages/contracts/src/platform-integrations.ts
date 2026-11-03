import { z } from 'zod';

/**
 * Installation-wide integrations that SAMPLEDGE sets up once for every workspace, from the Super Admin Console
 * (Console > Integrations), instead of in the server's environment file. Secrets are encrypted in the database and
 * never sent back to the browser; only their last characters are shown.
 *
 * Workspace-level integrations (Slack, webhooks, API keys, single sign-on) stay in each workspace's own
 * Settings > Integrations in the Web Portal.
 */
export const PLATFORM_INTEGRATION_KEYS = ['ai', 'email', 'push', 'scanning', 'mobile_sso'] as const;
export type PlatformIntegrationKey = (typeof PLATFORM_INTEGRATION_KEYS)[number];

/** Where the setting in effect comes from: saved in the Console, the server's environment (bootstrap fallback), or nowhere. */
export type IntegrationSource = 'console' | 'environment' | 'none';

export const AI_EFFORTS = ['low', 'medium', 'high'] as const;
export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;

const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, 'Enter a host name such as smtp.sendgrid.net (no protocol or port)');
/** A secret field: a new value replaces the saved one, empty or missing keeps it, null removes it. */
const optionalSecret = z.string().max(2000).nullable().optional();

export const aiIntegrationInput = z.object({
  enabled: z.boolean(),
  /** Leave empty to keep the key already saved. */
  apiKey: optionalSecret,
  model: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9._:\[\]-]+$/, 'Model ids look like claude-opus-5-5'),
  effort: z.enum(AI_EFFORTS),
  refusalFallback: z.boolean(),
  timeoutSeconds: z.number().int().min(5).max(120),
  /** Optional regional gateway. Empty means https://api.anthropic.com. */
  baseUrl: z.union([z.literal(''), z.string().trim().url().max(300)]).optional(),
}).strict();

export const emailIntegrationInput = z.object({
  enabled: z.boolean(),
  host,
  port: z.number().int().min(1).max(65535),
  security: z.enum(SMTP_SECURITY),
  username: z.string().trim().max(200).optional(),
  /** Leave empty to keep the password already saved. */
  password: optionalSecret,
  /** The From line, e.g. CREW <no-reply@yourcompany.com>. */
  from: z.string().trim().min(3).max(200).regex(/^(?:[^<>@]*<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)$/, 'Enter an address, or a name and address like CREW <no-reply@yourcompany.com>'),
}).strict();

export const pushIntegrationInput = z.object({
  enabled: z.boolean(),
  /** Expo access token, needed when "Enhanced security for push notifications" is on. Empty keeps the saved one. */
  accessToken: optionalSecret,
}).strict();

export const scanningIntegrationInput = z.object({
  enabled: z.boolean(),
  url: z.string().trim().regex(/^tcp:\/\/[^\s/:]+:\d+$/, 'Enter the scanner address as tcp://host:3310'),
}).strict();

export const mobileSsoIntegrationInput = z.object({
  enabled: z.boolean(),
  redirects: z.array(z.string().trim().min(3).max(300).regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i, 'Each address needs a scheme, like crew://sso')).min(1).max(10),
}).strict();

export const PLATFORM_INTEGRATION_INPUTS = {
  ai: aiIntegrationInput,
  email: emailIntegrationInput,
  push: pushIntegrationInput,
  scanning: scanningIntegrationInput,
  mobile_sso: mobileSsoIntegrationInput,
} as const;

export type PlatformIntegrationInput<K extends PlatformIntegrationKey = PlatformIntegrationKey> = z.infer<(typeof PLATFORM_INTEGRATION_INPUTS)[K]>;

/** Extra values a connection test can use; they are never saved. */
export const integrationTestExtras = z.object({
  /** Email: where to send the test message. */
  sendTo: z.email().max(200).optional(),
  /** Push: an Expo push token (ExponentPushToken[...]) to send a real test notification to. */
  pushToken: z.string().trim().regex(/^Expo(nent)?PushToken\[[^\]]{10,200}\]$/, 'Expo push tokens look like ExponentPushToken[xxxxxxxx]').optional(),
}).strict();
export type IntegrationTestExtras = z.infer<typeof integrationTestExtras>;

/** Secret fields per integration (stored encrypted, never returned). */
export const PLATFORM_INTEGRATION_SECRETS: Record<PlatformIntegrationKey, readonly string[]> = {
  ai: ['apiKey'],
  email: ['password'],
  push: ['accessToken'],
  scanning: [],
  mobile_sso: [],
};

export interface PlatformIntegrationStep { title: string; body: string; link?: { label: string; href: string } }

export interface PlatformIntegrationDef {
  key: PlatformIntegrationKey;
  name: string;
  category: string;
  description: string;
  /** What stops working (or works in a reduced way) while this is not set up. */
  whenOff: string;
  /** The environment variables used only while nothing is saved in the Console. */
  envFallback: readonly string[];
  steps: readonly PlatformIntegrationStep[];
}

export const PLATFORM_INTEGRATIONS: readonly PlatformIntegrationDef[] = [
  {
    key: 'ai',
    name: 'Claude AI',
    category: 'AI',
    description: 'Powers the HR assistant, CREW IQ, help desk reply drafts and the workflow writer for every workspace whose plan includes AI.',
    whenOff: 'Every AI feature says AI is not set up, and no data is sent to any AI service.',
    envFallback: ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'AI_MODEL', 'AI_EFFORT', 'AI_REFUSAL_FALLBACK', 'AI_TIMEOUT_MS'],
    steps: [
      { title: 'Create an API key', body: 'Sign in to the Claude Console, open API keys and create a key for CREW. Give it its own workspace there so you can see CREW\'s usage and set a spend limit.', link: { label: 'Open the Claude Console', href: 'https://console.anthropic.com/settings/keys' } },
      { title: 'Paste the key and choose the model', body: 'Paste the key below. claude-opus-5-5 is the default; a smaller model costs less. Effort "low" suits CREW\'s short answers.' },
      { title: 'Test, then switch on', body: 'Test connection sends one short message ("Reply with OK") using the values on screen. Once it passes, switch AI on and save. Each workspace still chooses which AI features to use in its own Settings > AI.' },
    ],
  },
  {
    key: 'email',
    name: 'Email (SMTP)',
    category: 'Messaging',
    description: 'Sends invitations, password resets, approvals, payslip notices and proposals for every workspace.',
    whenOff: 'Emails are kept in CREW and marked "not delivered"; nobody receives them.',
    envFallback: ['SMTP_URL', 'MAIL_FROM'],
    steps: [
      { title: 'Get SMTP details from your email provider', body: 'Any provider with SMTP works: Amazon SES, SendGrid, Postmark, Mailgun, Microsoft 365 or Google Workspace. You need a host, a port, a user name and a password or API key.' },
      { title: 'Verify your sending domain', body: 'Add the SPF and DKIM records your provider gives you to your domain\'s DNS, so mail from CREW is not marked as spam. Use an address on that domain as the From line.' },
      { title: 'Test, then switch on', body: 'Test connection signs in to the server and sends a real test email to the address you give. Port 587 with STARTTLS is the usual choice; 465 uses TLS from the start.' },
    ],
  },
  {
    key: 'push',
    name: 'Mobile push (Expo)',
    category: 'Messaging',
    description: 'Sends "you have something new" alerts to the CREW mobile app on iPhone and Android. The text itself is only loaded inside the signed-in app.',
    whenOff: 'The mobile app still shows notifications when opened, but phones are not alerted.',
    envFallback: ['EXPO_PUSH_ENABLED', 'EXPO_ACCESS_TOKEN'],
    steps: [
      { title: 'Build the app with your Expo project', body: 'Push needs the CREW app built with EAS under your Expo account (EAS_PROJECT_ID in the mobile build). The app then registers each phone with Expo when people sign in.', link: { label: 'Expo push setup guide', href: 'https://docs.expo.dev/push-notifications/push-notifications-setup/' } },
      { title: 'Add an access token if push security is on', body: 'If "Enhanced security for push notifications" is switched on for the Expo project, create an access token under Account settings > Access tokens and paste it below. Otherwise leave it empty.', link: { label: 'Expo access tokens', href: 'https://expo.dev/settings/access-tokens' } },
      { title: 'Test, then switch on', body: 'Test connection checks that the Expo push service accepts CREW\'s requests. Paste a device\'s Expo push token to send it a real test alert.' },
    ],
  },
  {
    key: 'scanning',
    name: 'Virus scanning (ClamAV)',
    category: 'Security',
    description: 'Scans every uploaded document, receipt and CV before it is stored, and refuses infected files.',
    whenOff: 'Uploads are stored without a virus scan (System health says so).',
    envFallback: ['CLAMAV_URL'],
    steps: [
      { title: 'Run the scanner', body: 'Start the ClamAV service that ships with CREW (infra/deploy/compose.yml, profile "scan"), or any clamd your servers can reach on port 3310.' },
      { title: 'Enter its address and test', body: 'Enter the address as tcp://host:3310 and press Test connection, which asks the scanner to answer PING. While scanning is on, uploads are refused if the scanner cannot be reached, so no file is stored unscanned.' },
    ],
  },
  {
    key: 'mobile_sso',
    name: 'Mobile app single sign-on',
    category: 'Sign-in',
    description: 'The app addresses the Web Portal may send a finished single sign-on back to, so people can use their company sign-in in the mobile app.',
    whenOff: 'Only the built-in app address crew://sso is accepted.',
    envFallback: ['MOBILE_SSO_REDIRECTS'],
    steps: [
      { title: 'List the app addresses', body: 'crew://sso is the CREW app on iPhone and Android. Add another address only for your own branded build of the app, or http://localhost:8081/sso for the browser preview during development.' },
      { title: 'Save', body: 'Workspaces turn single sign-on on themselves in Settings > Single sign-on; this list only controls where the mobile app may be sent back to.' },
    ],
  },
];

/** What the Console shows for one integration. Secret values are replaced by a hint (last characters) or null. */
export interface PlatformIntegrationView {
  key: PlatformIntegrationKey;
  source: IntegrationSource;
  enabled: boolean;
  /** Non-secret settings in effect (from the Console, else from the environment). */
  settings: Record<string, unknown>;
  /** For each secret: whether one is in effect, and its last characters. */
  secrets: Record<string, { set: boolean; hint: string | null }>;
  /** True when environment values exist that a Console setting overrides (or would take over again on reset). */
  environmentAvailable: boolean;
  lastTest: { ok: boolean; detail: string; at: string; current: boolean } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** What a workspace sees in its Settings > Integrations about the installation-wide services. Never any settings. */
export interface PlatformServiceStatus { key: PlatformIntegrationKey; name: string; description: string; on: boolean; whenOff: string }
