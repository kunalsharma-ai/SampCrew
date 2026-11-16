import { z } from 'zod';

/**
 * Installation-wide integrations that SAMPLEDGE sets up once for every workspace, from the Super Admin Console
 * (Console > Integrations). They are kept only in the database, never in the server's environment or a settings
 * file: secrets are encrypted there with the field encryption key and never sent back to the browser; only their
 * last characters are shown.
 *
 * Workspace-level integrations (Slack, webhooks, API keys, single sign-on) stay in each workspace's own
 * Settings > Integrations in the Web Portal.
 */
export const PLATFORM_INTEGRATION_KEYS = ['ai', 'email', 'push', 'scanning', 'mobile_sso', 'razorpay', 'stripe', 'backups'] as const;
/** The integrations that collect payments for SampCrew subscriptions. */
export const PAYMENT_GATEWAYS = ['razorpay', 'stripe'] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];
export type PlatformIntegrationKey = (typeof PLATFORM_INTEGRATION_KEYS)[number];

/**
 * Where the setting in effect comes from: saved in the Console (or by the `integrations` command), SampCrew's built-in
 * default (only the mobile app's own sign-in address has one), or nowhere yet.
 */
export type IntegrationSource = 'console' | 'default' | 'none';

/** Integrations that only SAMPLEDGE's own operations use; workspaces are never told about them. */
export const INTERNAL_PLATFORM_INTEGRATIONS: readonly PlatformIntegrationKey[] = ['backups'];

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

/** Where the off-site copy of the backups is kept. */
export const BACKUP_STORAGE_PROVIDERS = ['s3', 'azure', 'sftp', 'folder'] as const;
export type BackupStorageProvider = (typeof BACKUP_STORAGE_PROVIDERS)[number];

const storagePath = z.string().trim().max(300).regex(/^[A-Za-z0-9._\/-]*$/, 'Use letters, digits, dots, dashes, underscores and slashes').optional();

/**
 * The off-site copy of the database and file backups (infra/deploy/scripts/backup.sh). The backup service reads these
 * from the database before every copy, so a change applies without a restart. One provider's fields are used:
 *   s3      Amazon S3 or any S3-compatible storage (Backblaze B2, Cloudflare R2, Wasabi, DigitalOcean Spaces, MinIO,
 *           Google Cloud Storage with HMAC keys): bucket, region, endpoint (empty for Amazon), access key id + secret
 *   azure   Azure Blob Storage: account, container, account key
 *   sftp    another server over SFTP: host, port, user, private key or password
 *   folder  a folder on the backup server itself, e.g. a mounted network drive (no secret)
 */
export const backupsIntegrationInput = z.object({
  enabled: z.boolean(),
  provider: z.enum(BACKUP_STORAGE_PROVIDERS),
  /** s3: bucket name. azure: container name. */
  bucket: z.string().trim().max(63).regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Bucket and container names use lower-case letters, digits, dots and dashes (3 to 63)').optional(),
  /** s3: e.g. ap-south-1. Empty means us-east-1 (S3-compatible services often accept any value, such as auto for R2). */
  region: z.union([z.literal(''), z.string().trim().max(40).regex(/^[a-z0-9-]+$/, 'Regions look like ap-south-1')]).optional(),
  /** s3: the service's address for S3-compatible storage. Empty means Amazon S3. */
  endpoint: z.union([z.literal(''), z.string().trim().url().max(300)]).optional(),
  accessKeyId: z.string().trim().max(200).optional(),
  /** s3: the secret access key. Leave empty to keep the saved one. */
  secretAccessKey: optionalSecret,
  /** azure: the storage account name. */
  account: z.string().trim().max(24).regex(/^[a-z0-9]{3,24}$/, 'Storage account names are 3 to 24 lower-case letters and digits').optional(),
  /** azure: an access key of the storage account. Leave empty to keep the saved one. */
  accountKey: optionalSecret,
  /** sftp: the server and the user to sign in as. */
  host: host.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().max(100).regex(/^[A-Za-z0-9._-]+$/, 'Enter a user name such as sampcrew').optional(),
  /** sftp: an OpenSSH private key (preferred) or a password. Empty keeps the saved one. */
  privateKey: optionalSecret,
  password: optionalSecret,
  /** The folder inside the bucket or container (s3, azure), on the server (sftp), or on this server (folder: absolute). */
  path: storagePath,
  /** Delete off-site copies older than this many days; 0 keeps them (e.g. when the bucket has its own retention rule). */
  keepDays: z.number().int().min(0).max(3650),
  /** Optional: posted {"text": "..."} when a backup or its off-site copy fails (Slack, Teams or Google Chat incoming webhook). Empty keeps the saved one. */
  alertWebhook: optionalSecret,
}).strict().superRefine((v, ctx) => {
  const need = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
  if (v.provider === 's3') {
    if (!v.bucket) need('bucket', 'Enter the bucket name');
    if (!v.accessKeyId) need('accessKeyId', 'Enter the access key id');
  }
  if (v.provider === 'azure') {
    if (!v.account) need('account', 'Enter the storage account name');
    if (!v.bucket) need('bucket', 'Enter the container name');
  }
  if (v.provider === 'sftp') {
    if (!v.host) need('host', 'Enter the server address');
    if (!v.user) need('user', 'Enter the user name');
    if (!v.path) need('path', 'Enter the folder on the server, e.g. /srv/backups/sampcrew');
  }
  if (v.provider === 'folder' && !v.path?.startsWith('/')) need('path', 'Enter the full path of the folder, e.g. /mnt/nas/sampcrew');
});

export const PLATFORM_INTEGRATION_INPUTS = {
  ai: aiIntegrationInput,
  email: emailIntegrationInput,
  push: pushIntegrationInput,
  scanning: scanningIntegrationInput,
  mobile_sso: mobileSsoIntegrationInput,
  razorpay: razorpayIntegrationInput,
  stripe: stripeIntegrationInput,
  backups: backupsIntegrationInput,
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
  backups: ['secretAccessKey', 'accountKey', 'privateKey', 'password', 'alertWebhook'],
};

export interface PlatformIntegrationStep { title: string; body: string; link?: { label: string; href: string } }

export interface PlatformIntegrationDef {
  key: PlatformIntegrationKey;
  name: string;
  category: string;
  description: string;
  /** What stops working (or works in a reduced way) while this is not set up. */
  whenOff: string;
  /**
   * Variables older SampCrew releases read from the server's environment. If one is still set when the API (or, for
   * backups, the backup service) starts and nothing is saved for this integration, its value is moved into the
   * database once and the Console asks for the line to be deleted. It is never read after that.
   */
  legacyVariables: readonly string[];
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
    legacyVariables: ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'AI_MODEL', 'AI_EFFORT', 'AI_REFUSAL_FALLBACK', 'AI_TIMEOUT_MS'],
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
    legacyVariables: ['SMTP_URL', 'MAIL_FROM'],
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
    legacyVariables: ['EXPO_PUSH_ENABLED', 'EXPO_ACCESS_TOKEN'],
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
    legacyVariables: ['CLAMAV_URL'],
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
    whenOff: 'Single sign-on cannot send people back to the mobile app.',
    legacyVariables: ['MOBILE_SSO_REDIRECTS'],
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
    legacyVariables: [],
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
    legacyVariables: [],
    webhookPath: '/api/v1/billing/webhooks/stripe',
    steps: [
      { title: 'Create a secret key', body: 'In the Stripe Dashboard open Developers > API keys. Use the test mode secret key (sk_test_...) first and the live one (sk_live_...) when you go live. A restricted key needs write access to Customers, Checkout Sessions and Payment Intents.', link: { label: 'Open Stripe API keys', href: 'https://dashboard.stripe.com/apikeys' } },
      { title: 'Add the webhook endpoint', body: 'In Developers > Webhooks add an endpoint with the address shown below and the events checkout.session.completed and checkout.session.expired. Copy its signing secret (whsec_...) and paste it below.', link: { label: 'Open Stripe webhooks', href: 'https://dashboard.stripe.com/webhooks' } },
      { title: 'Test, then switch on', body: 'Test connection reads your Stripe balance with the key. Then switch it on and choose in Billing > Settings which currencies Stripe collects (all except INR by default).' },
    ],
  },
  {
    key: 'backups',
    name: 'Off-site backups',
    category: 'Operations',
    description: 'Copies the daily database and file backups, and the point-in-time backups, to storage away from this server, so they survive losing it. Failures can alert a chat channel.',
    whenOff: 'Backups stay on this server only: losing its disk loses them too (System health warns about it).',
    legacyVariables: ['BACKUP_REMOTE', 'BACKUP_REMOTE_KEEP_DAYS', 'BACKUP_ALERT_WEBHOOK', 'RCLONE_CONFIG_OFFSITE_*'],
    steps: [
      { title: 'Create a bucket and a key just for SampCrew', body: 'Amazon S3, Backblaze B2, Cloudflare R2, Wasabi, DigitalOcean Spaces, MinIO and Google Cloud Storage (HMAC keys) all work as "S3-compatible". Turn versioning on (and object lock or retention if offered), and give the key access to that bucket only.' },
      { title: 'Enter the details and test', body: 'Test connection writes a small check file to the folder and lists it, exactly as the backup service will. For SFTP it checks that the server answers; the sign-in itself is checked by the next copy (System health shows the result).' },
      { title: 'Switch on and keep a copy of the keys', body: 'The backup service picks up the change before its next copy (every 15 minutes), with no restart. Also keep the storage keys and BACKUP_PASSPHRASE in your password manager: after losing the whole server, you type them in again to fetch the backups (docs/ops/mongodb.md, "Disaster recovery").' },
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
  /** Non-secret settings in effect (saved, else the built-in default). */
  settings: Record<string, unknown>;
  /** For each secret: whether one is saved, and its last characters. */
  secrets: Record<string, { set: boolean; hint: string | null }>;
  /**
   * Set when the setting was moved into the database from an older release's environment variables and has not been
   * saved in the Console since: those lines should be deleted from the server's settings file.
   */
  imported: { variables: string[]; at: string } | null;
  lastTest: { ok: boolean; detail: string; at: string; current: boolean } | null;
  updatedAt: string | null;
  /** Who saved it: a Console admin's name, or how it was saved otherwise (the integrations command, an import). */
  updatedBy: string | null;
}

/** What a workspace sees in its Settings > Integrations about the installation-wide services. Never any settings. */
export interface PlatformServiceStatus { key: PlatformIntegrationKey; name: string; description: string; on: boolean; whenOff: string }
