import { z } from 'zod';

/**
 * Installation-wide integrations that SAMPLEDGE sets up once for every workspace, from the Super Admin Console
 * (Console > Integrations), instead of in the server's environment file. Secrets are encrypted in the database and
 * never sent back to the browser; only their last characters are shown.
 *
 * Workspace-level integrations (Slack, webhooks, API keys, single sign-on) stay in each workspace's own
 * Settings > Integrations in the Web Portal.
 */
export const PLATFORM_INTEGRATION_KEYS = ['ai', 'email', 'push', 'scanning', 'mobile_sso', 'razorpay', 'stripe'] as const;
/** The integrations that collect payments for SampCrew subscriptions. */
export const PAYMENT_GATEWAYS = ['razorpay', 'stripe'] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];
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
  /** The From line, e.g. SampCrew <no-reply@yourcompany.com>. */
  from: z.string().trim().min(3).max(200).regex(/^(?:[^<>@]*<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)$/, 'Enter an address, or a name and address like SampCrew <no-reply@yourcompany.com>'),
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

const gatewayBaseUrl = z.union([z.literal(''), z.string().trim().url().max(300)]).optional();

/** Razorpay (India: cards, UPI, net banking, wallets). Payments are taken on Razorpay payment links. */
export const razorpayIntegrationInput = z.object({
  enabled: z.boolean(),
  /** The public key id, rzp_test_... or rzp_live_... */
  keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/, 'Razorpay key ids look like rzp_live_XXXXXXXXXXXXXX'),
  /** Leave empty to keep the saved key secret. */
  keySecret: optionalSecret,
  /** The secret typed when the webhook was added in the Razorpay Dashboard. Empty keeps the saved one. */
  webhookSecret: optionalSecret,
  /** Only for a test stand-in. Empty means https://api.razorpay.com. */
  baseUrl: gatewayBaseUrl,
}).strict();

/** Stripe (cards and wallets worldwide). Payments are taken on Stripe Checkout; saved cards renew automatically. */
export const stripeIntegrationInput = z.object({
  enabled: z.boolean(),
  /** Optional: shown for reference only (pk_live_... or pk_test_...). */
  publishableKey: z.union([z.literal(''), z.string().trim().regex(/^pk_(test|live)_[A-Za-z0-9]{6,200}$/, 'Publishable keys look like pk_live_...')]).optional(),
  /** sk_live_... or a restricted key rk_live_... Leave empty to keep the saved one. */
  secretKey: optionalSecret,
  /** The signing secret of the webhook endpoint (whsec_...). Empty keeps the saved one. */
  webhookSecret: optionalSecret,
  /** Only for a test stand-in. Empty means https://api.stripe.com. */
  baseUrl: gatewayBaseUrl,
}).strict();

export const PLATFORM_INTEGRATION_INPUTS = {
  ai: aiIntegrationInput,
  email: emailIntegrationInput,
  push: pushIntegrationInput,
  scanning: scanningIntegrationInput,
  mobile_sso: mobileSsoIntegrationInput,
  razorpay: razorpayIntegrationInput,
  stripe: stripeIntegrationInput,
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
  razorpay: ['keySecret', 'webhookSecret'],
  stripe: ['secretKey', 'webhookSecret'],
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
  /** Where the provider must send its webhooks, relative to the API's public address. */
  webhookPath?: string;
  steps: readonly PlatformIntegrationStep[];
}

export const PLATFORM_INTEGRATIONS: readonly PlatformIntegrationDef[] = [
  {
    key: 'ai',
    name: 'Claude AI',
    category: 'AI',
    description: 'Powers the HR assistant, SampCrew IQ, help desk reply drafts and the workflow writer for every workspace whose plan includes AI.',
    whenOff: 'Every AI feature says AI is not set up, and no data is sent to any AI service.',
    envFallback: ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'AI_MODEL', 'AI_EFFORT', 'AI_REFUSAL_FALLBACK', 'AI_TIMEOUT_MS'],
    steps: [
      { title: 'Create an API key', body: 'Sign in to the Claude Console, open API keys and create a key for SampCrew. Give it its own workspace there so you can see SampCrew\'s usage and set a spend limit.', link: { label: 'Open the Claude Console', href: 'https://console.anthropic.com/settings/keys' } },
      { title: 'Paste the key and choose the model', body: 'Paste the key below. claude-opus-5-5 is the default; a smaller model costs less. Effort "low" suits SampCrew\'s short answers.' },
      { title: 'Test, then switch on', body: 'Test connection sends one short message ("Reply with OK") using the values on screen. Once it passes, switch AI on and save. Each workspace still chooses which AI features to use in its own Settings > AI.' },
    ],
  },
  {
    key: 'email',
    name: 'Email (SMTP)',
    category: 'Messaging',
    description: 'Sends invitations, password resets, approvals, payslip notices and proposals for every workspace.',
    whenOff: 'Emails are kept in SampCrew and marked "not delivered"; nobody receives them.',
    envFallback: ['SMTP_URL', 'MAIL_FROM'],
    steps: [
      { title: 'Get SMTP details from your email provider', body: 'Any provider with SMTP works: Amazon SES, SendGrid, Postmark, Mailgun, Microsoft 365 or Google Workspace. You need a host, a port, a user name and a password or API key.' },
      { title: 'Verify your sending domain', body: 'Add the SPF and DKIM records your provider gives you to your domain\'s DNS, so mail from SampCrew is not marked as spam. Use an address on that domain as the From line.' },
      { title: 'Test, then switch on', body: 'Test connection signs in to the server and sends a real test email to the address you give. Port 587 with STARTTLS is the usual choice; 465 uses TLS from the start.' },
    ],
  },
  {
    key: 'push',
    name: 'Mobile push (Expo)',
    category: 'Messaging',
    description: 'Sends "you have something new" alerts to the SampCrew mobile app on iPhone and Android. The text itself is only loaded inside the signed-in app.',
    whenOff: 'The mobile app still shows notifications when opened, but phones are not alerted.',
    envFallback: ['EXPO_PUSH_ENABLED', 'EXPO_ACCESS_TOKEN'],
    steps: [
      { title: 'Build the app with your Expo project', body: 'Push needs the SampCrew app built with EAS under your Expo account (EAS_PROJECT_ID in the mobile build). The app then registers each phone with Expo when people sign in.', link: { label: 'Expo push setup guide', href: 'https://docs.expo.dev/push-notifications/push-notifications-setup/' } },
      { title: 'Add an access token if push security is on', body: 'If "Enhanced security for push notifications" is switched on for the Expo project, create an access token under Account settings > Access tokens and paste it below. Otherwise leave it empty.', link: { label: 'Expo access tokens', href: 'https://expo.dev/settings/access-tokens' } },
      { title: 'Test, then switch on', body: 'Test connection checks that the Expo push service accepts SampCrew\'s requests. Paste a device\'s Expo push token to send it a real test alert.' },
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
      { title: 'Run the scanner', body: 'Start the ClamAV service that ships with SampCrew (infra/deploy/compose.yml, profile "scan"), or any clamd your servers can reach on port 3310.' },
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
      { title: 'List the app addresses', body: 'crew://sso is the SampCrew app on iPhone and Android. Add another address only for your own branded build of the app, or http://localhost:8081/sso for the browser preview during development.' },
      { title: 'Save', body: 'Workspaces turn single sign-on on themselves in Settings > Single sign-on; this list only controls where the mobile app may be sent back to.' },
    ],
  },
  {
    key: 'razorpay',
    name: 'Razorpay payments',
    category: 'Payments',
    description: 'Collects subscription, upgrade, add-on and invoice payments by card, UPI, net banking and wallets, usually for workspaces billed in INR. Paid invoices are marked paid and the plan change is applied automatically.',
    whenOff: 'Workspaces cannot pay online with Razorpay. Plan changes are invoiced and SAMPLEDGE finance marks invoices paid by hand.',
    envFallback: [],
    webhookPath: '/api/v1/billing/webhooks/razorpay',
    steps: [
      { title: 'Create API keys', body: 'In the Razorpay Dashboard open Account & Settings > API Keys and generate a key. Use Test mode keys (rzp_test_...) first and Live mode keys (rzp_live_...) when you go live. Payment links must be enabled on the account.', link: { label: 'Open Razorpay API keys', href: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys' } },
      { title: 'Add the webhook', body: 'In Account & Settings > Webhooks add the webhook address shown below, choose a secret and tick the events payment_link.paid, payment_link.expired and payment_link.cancelled. Paste the same secret below.', link: { label: 'Open Razorpay webhooks', href: 'https://dashboard.razorpay.com/app/webhooks' } },
      { title: 'Test, then switch on', body: 'Test connection signs in to Razorpay with the key and secret. Then switch it on and choose in Billing > Settings which currencies Razorpay collects (INR by default).' },
    ],
  },
  {
    key: 'stripe',
    name: 'Stripe payments',
    category: 'Payments',
    description: 'Collects subscription, upgrade, add-on and invoice payments by card and wallets in any currency on Stripe Checkout. The card is saved, so renewals are charged automatically.',
    whenOff: 'Workspaces cannot pay online with Stripe. Plan changes are invoiced and SAMPLEDGE finance marks invoices paid by hand.',
    envFallback: [],
    webhookPath: '/api/v1/billing/webhooks/stripe',
    steps: [
      { title: 'Create a secret key', body: 'In the Stripe Dashboard open Developers > API keys. Use the test mode secret key (sk_test_...) first and the live one (sk_live_...) when you go live. A restricted key needs write access to Customers, Checkout Sessions and Payment Intents.', link: { label: 'Open Stripe API keys', href: 'https://dashboard.stripe.com/apikeys' } },
      { title: 'Add the webhook endpoint', body: 'In Developers > Webhooks add an endpoint with the address shown below and the events checkout.session.completed and checkout.session.expired. Copy its signing secret (whsec_...) and paste it below.', link: { label: 'Open Stripe webhooks', href: 'https://dashboard.stripe.com/webhooks' } },
      { title: 'Test, then switch on', body: 'Test connection reads your Stripe balance with the key. Then switch it on and choose in Billing > Settings which currencies Stripe collects (all except INR by default).' },
    ],
  },
];

/** What the Console shows for one integration. Secret values are replaced by a hint (last characters) or null. */
export interface PlatformIntegrationView {
  key: PlatformIntegrationKey;
  /** For payment gateways: the full address to enter in the provider's webhook settings. */
  webhookUrl?: string;
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
