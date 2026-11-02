import { z } from 'zod';

/**
 * Enterprise identity and privacy: single sign-on with OpenID Connect or SAML 2.0 (web and mobile), SCIM 2.0
 * provisioning of users and groups, privacy requests and retention schedules.
 */

export const SCIM_TOKEN_PREFIX = 'scim_';
/** scim_<10-char prefix>_<secret>. Returns null for anything else. */
export function parseScimToken(token: string): { prefix: string; secret: string } | null {
  const m = /^scim_([a-z0-9]{10})_([A-Za-z0-9_-]{32,64})$/.exec(token);
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'A domain such as example.com, without @');

const ssoCommon = {
  domains: z.array(domain).min(1).max(20).refine((d) => new Set(d).size === d.length, 'Each domain once'),
  jitProvisioning: z.boolean().default(false),
};
export const oidcConnectionInput = z.object({
  protocol: z.literal('oidc').default('oidc'),
  issuer: z.url({ protocol: /^https?$/ }).max(500),
  clientId: z.string().trim().min(1).max(300),
  /** Leave out when changing other settings to keep the stored secret. */
  clientSecret: z.string().min(1).max(500).optional(),
  ...ssoCommon,
});
export const samlConnectionInput = z.object({
  protocol: z.literal('saml'),
  /** The identity provider's entity ID (the Issuer of its responses), for example http://www.okta.com/exk1... */
  idpEntityId: z.string().trim().min(1).max(500),
  /** The identity provider's single sign-on URL for the HTTP-Redirect binding. */
  ssoUrl: z.url({ protocol: /^https?$/ }).max(1000),
  /** The identity provider's signing certificate: PEM, or the base64 body from its metadata. */
  /** Leave out to keep the stored certificate when changing other settings. */
  certificate: z.string().trim().min(100).max(20000).optional(),
  ...ssoCommon,
});
/** A connection is SAML when protocol is "saml"; anything else (including no protocol) is OpenID Connect. */
export const ssoConnectionInput = z.union([samlConnectionInput, oidcConnectionInput]);
export type SsoConnectionInput = z.infer<typeof ssoConnectionInput>;

/** A PKCE challenge (S256, base64url): 43 characters. */
const pkceChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'A base64url SHA-256 challenge');
export const ssoStartInput = z.object({
  email: z.email().max(254),
  /** Mobile only: where the app wants the browser sent back (must be on the installation's allow-list). */
  returnTo: z.string().max(300).optional(),
  /** Mobile only: the app's own PKCE challenge, so only the app that started the sign-in can collect the session. */
  appChallenge: pkceChallenge.optional(),
});
export const ssoExchangeInput = z.object({ code: z.string().min(20).max(100), verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) });
export const samlCallbackInput = z.object({ samlResponse: z.string().min(100).max(500_000), relayState: z.string().min(20).max(200) });
export const ssoCallbackInput = z.object({ code: z.string().min(1).max(4000), state: z.string().min(20).max(200) });

export const ssoStatusInput = z.object({ status: z.enum(['active', 'disabled']), enforced: z.boolean().default(false) });

/** amr values (RFC 8176) that mean the identity provider used more than a password. */
export const MFA_AMR = ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face', 'iris', 'retina', 'sc', 'pop'] as const;
export const ssoSatisfiesMfa = (amr: unknown) => Array.isArray(amr) && amr.some((a) => (MFA_AMR as readonly string[]).includes(String(a)));

/** SAML authentication contexts that mean more than a password (SAML 2.0 classes, REFEDS MFA, Entra ID). */
export const SAML_MFA_CONTEXTS = [
  'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract',
  'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered',
  'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken',
  'urn:oasis:names:tc:SAML:2.0:ac:classes:Smartcard',
  'urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI',
  'https://refeds.org/profile/mfa',
  'http://schemas.microsoft.com/claims/multipleauthn',
] as const;
/** True when a SAML assertion's AuthnContextClassRef, or Entra ID's authnmethodsreferences attribute, says MFA. */
export const samlSatisfiesMfa = (contexts: unknown[]) => contexts.some((c) => (SAML_MFA_CONTEXTS as readonly string[]).includes(String(c)));

export const emailDomain = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';

// SCIM --------------------------------------------------------------------------------------------------------------

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export const scimUserInput = z.looseObject({
  userName: z.string().trim().min(3).max(254),
  externalId: z.string().max(300).optional(),
  active: z.boolean().default(true),
  name: z.looseObject({ givenName: z.string().max(80).optional(), familyName: z.string().max(80).optional(), formatted: z.string().max(160).optional() }).optional(),
  displayName: z.string().max(160).optional(),
  emails: z.array(z.looseObject({ value: z.string().max(254), primary: z.boolean().optional(), type: z.string().optional() })).max(10).optional(),
});
export type ScimUserInput = z.infer<typeof scimUserInput>;

export const scimPatchInput = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(z.object({ op: z.string().transform((s) => s.toLowerCase()).pipe(z.enum(['add', 'replace', 'remove'])), path: z.string().max(200).optional(), value: z.unknown().optional() }))
    .min(1)
    .max(50),
});
export type ScimPatchInput = z.infer<typeof scimPatchInput>;

/** The email a SCIM user signs in with: the primary work email, else userName when it is an email. */
export function scimEmail(u: Pick<ScimUserInput, 'userName' | 'emails'>): string | null {
  const primary = u.emails?.find((e) => e.primary) ?? u.emails?.[0];
  const candidate = (primary?.value ?? u.userName).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) ? candidate : null;
}

export function scimFullName(u: Pick<ScimUserInput, 'name' | 'displayName' | 'userName'>): string {
  const n = [u.name?.givenName, u.name?.familyName].filter(Boolean).join(' ').trim();
  return (n || u.name?.formatted || u.displayName || u.userName).trim().slice(0, 160);
}

/**
 * Applies a SCIM PATCH to the fields CREW keeps (active, name, displayName, externalId, emails). Returns the
 * changed values and the operations it could not apply.
 */
export function applyScimPatch(current: { active: boolean; givenName: string; familyName: string; externalId: string | null }, ops: ScimPatchInput['Operations']) {
  const next = { ...current };
  const ignored: string[] = [];
  const set = (path: string, value: unknown) => {
    const p = path.toLowerCase();
    if (p === 'active') next.active = value === true || value === 'true' || value === 'True';
    else if (p === 'name.givenname') next.givenName = String(value ?? '').slice(0, 80);
    else if (p === 'name.familyname') next.familyName = String(value ?? '').slice(0, 80);
    else if (p === 'externalid') next.externalId = value == null ? null : String(value).slice(0, 300);
    else if (p === 'name' && value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (v.givenName !== undefined) next.givenName = String(v.givenName).slice(0, 80);
      if (v.familyName !== undefined) next.familyName = String(v.familyName).slice(0, 80);
    } else ignored.push(path);
  };
  for (const op of ops) {
    if (op.op === 'remove') {
      if (op.path?.toLowerCase() === 'externalid') next.externalId = null;
      else ignored.push(op.path ?? '(no path)');
      continue;
    }
    if (op.path) set(op.path, op.value);
    else if (op.value && typeof op.value === 'object') for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) set(k, v);
    else ignored.push('(no path)');
  }
  return { next, ignored };
}

/**
 * SCIM filters CREW answers: `<attr> eq "x"` for userName and externalId on users, displayName and externalId on
 * groups (what Okta and Entra ID send).
 */
export function parseScimFilter<A extends string = 'userName' | 'externalId'>(
  filter: string | undefined,
  attrs: readonly A[] = ['userName', 'externalId'] as unknown as A[],
): { attr: A; value: string } | null | 'unsupported' {
  if (!filter) return null;
  const m = /^\s*([A-Za-z]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attr = m && attrs.find((a) => a.toLowerCase() === m[1]!.toLowerCase());
  if (!m || !attr) return 'unsupported';
  return { attr, value: m[2]!.replace(/\\(.)/g, '$1') };
}

export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';

export const scimGroupInput = z.looseObject({
  displayName: z.string().trim().min(1).max(200),
  externalId: z.string().max(200).optional(),
  members: z.array(z.looseObject({ value: z.string().max(100) })).max(5000).optional(),
});
export type ScimGroupInput = z.infer<typeof scimGroupInput>;

/**
 * Reads a SCIM PATCH on a group in the shapes Okta and Microsoft Entra ID send: add/remove/replace on "members"
 * (with a value list, or a `members[value eq "id"]` path), and replace of displayName or externalId.
 */
export function applyScimGroupPatch(ops: ScimPatchInput['Operations']) {
  const out: { displayName?: string; externalId?: string | null; add: string[]; remove: string[]; replace?: string[]; ignored: string[] } = { add: [], remove: [], ignored: [] };
  const ids = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((m) => (m && typeof m === 'object' ? String((m as { value?: unknown }).value ?? '') : String(m))).filter(Boolean);
  for (const op of ops) {
    const path = op.path?.trim() ?? '';
    const filtered = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
    if (filtered) {
      if (op.op === 'remove') out.remove.push(filtered[1]!);
      else out.add.push(filtered[1]!);
    } else if (path.toLowerCase() === 'members') {
      if (op.op === 'add') out.add.push(...ids(op.value));
      else if (op.op === 'remove') {
        if (op.value === undefined) out.replace = [];
        else out.remove.push(...ids(op.value));
      } else out.replace = ids(op.value);
    } else if (path.toLowerCase() === 'displayname' && op.op !== 'remove') out.displayName = String(op.value ?? '').trim().slice(0, 200);
    else if (path.toLowerCase() === 'externalid') out.externalId = op.op === 'remove' || op.value == null ? null : String(op.value).slice(0, 200);
    else if (!path && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      if (typeof v.displayName === 'string') out.displayName = v.displayName.trim().slice(0, 200);
      if (v.externalId !== undefined) out.externalId = v.externalId == null ? null : String(v.externalId).slice(0, 200);
      if (v.members !== undefined) (op.op === 'add' ? out.add : (out.replace = [])).push(...ids(v.members));
    } else out.ignored.push(path || '(no path)');
  }
  if (out.displayName === '') delete out.displayName;
  return out;
}

/** Roles a provisioning group may grant: never the owner role, which only an owner can give in CREW. */
export const SCIM_UNMAPPABLE_ROLES = ['tenant_owner'] as const;
export const scimGroupRoleInput = z.object({ roleId: z.uuid().nullable() });

// Privacy requests ---------------------------------------------------------------------------------------------------

/** Statutory time to answer, in days (GDPR and UK GDPR: one month; India DPDP rules are not final, so 30 is used). */
export const PRIVACY_DUE_DAYS = 30;

export const privacyRequestInput = z.object({
  employeeId: z.uuid(),
  kind: z.enum(['access', 'erasure']),
  source: z.string().trim().min(3).max(300),
});
export const privacyDecisionInput = z.object({ note: z.string().trim().min(3).max(2000) });

/** What erasure does to each kind of record, shown to HR before they confirm and stored with the result. */
export const ERASURE_RULES = [
  { area: 'Identity and contact', action: 'erased', detail: 'Name replaced with "Erased person", the employee code replaced with a pseudonymous one, and personal email, phone, date of birth and gender removed. The work email is replaced.' },
  { area: 'Bank, tax and national ID', action: 'erased', detail: 'Removed.' },
  { area: 'Documents', action: 'erased', detail: 'Files deleted from storage and their records removed.' },
  { area: 'Sign-in account', action: 'erased', detail: 'Removed from this workspace and signed out everywhere; if the login belongs to no other workspace, its name and email are replaced and it is disabled.' },
  { area: 'Helpdesk cases they raised', action: 'erased', detail: 'Subject, description, rating comment and the messages they wrote replaced with "[erased]".' },
  { area: 'Reviews, feedback and goals', action: 'erased', detail: 'Written answers, comments, goal titles, descriptions and check-in notes replaced with "[erased]". Ratings, scores and dates are kept for workforce reports.' },
  { area: 'Recognition', action: 'erased', detail: 'Messages written to them replaced with "[erased]".' },
  { area: 'Requests and notes about them', action: 'erased', detail: 'Reasons on leave, attendance corrections and overtime claims, notes on job changes and courses, expense descriptions, attrition notes and scores, and approval summaries replaced or removed.' },
  { area: 'Their own app data', action: 'erased', detail: 'AI assistant conversations, personal notes, saved views, notifications, drafts and registered phones deleted.' },
  { area: 'Payroll, payslips and expense amounts', action: 'kept', detail: 'Amounts and receipts kept, linked to the pseudonymous record, because tax and labour law require payroll and expense records to be kept for several years.' },
  { area: 'Attendance and leave', action: 'kept', detail: 'Days, punches and leave balances kept against the pseudonymous record for wage and working-time records. Raw punches are never changed.' },
  { area: 'Audit trail', action: 'kept', detail: 'Kept unchanged: it is insert-only evidence of who did what, and its integrity chain would break if edited.' },
  { area: 'What colleagues already received', action: 'kept', detail: 'Notifications and emails already sent to other people are not changed. Text colleagues wrote about other people is not changed.' },
] as const;

// Retention schedules ------------------------------------------------------------------------------------------------

export const retentionPolicyInput = z.object({
  /** Erase people automatically this many years after their last working day; null leaves erasure to HR. */
  exitedErasureYears: z.number().int().min(1).max(30).nullable(),
  exportDays: z.number().int().min(1).max(365),
  signInLogDays: z.number().int().min(7).max(3650),
});
export type RetentionPolicyInput = z.infer<typeof retentionPolicyInput>;
export const RETENTION_DEFAULTS: RetentionPolicyInput = { exitedErasureYears: null, exportDays: 30, signInLogDays: 90 };
