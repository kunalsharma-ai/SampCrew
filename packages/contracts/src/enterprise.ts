import { z } from 'zod';

/**
 * Enterprise identity and privacy: single sign-on with OpenID Connect, SCIM 2.0 provisioning, and privacy
 * requests. SAML is not built yet.
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

export const ssoConnectionInput = z.object({
  issuer: z.url({ protocol: /^https?$/ }).max(500),
  clientId: z.string().trim().min(1).max(300),
  /** Leave out when changing other settings to keep the stored secret. */
  clientSecret: z.string().min(1).max(500).optional(),
  domains: z.array(domain).min(1).max(20).refine((d) => new Set(d).size === d.length, 'Each domain once'),
  jitProvisioning: z.boolean().default(false),
});
export type SsoConnectionInput = z.infer<typeof ssoConnectionInput>;

export const ssoStartInput = z.object({ email: z.email().max(254) });
export const ssoCallbackInput = z.object({ code: z.string().min(1).max(4000), state: z.string().min(20).max(200) });

export const ssoStatusInput = z.object({ status: z.enum(['active', 'disabled']), enforced: z.boolean().default(false) });

/** amr values (RFC 8176) that mean the identity provider used more than a password. */
export const MFA_AMR = ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face', 'iris', 'retina', 'sc', 'pop'] as const;
export const ssoSatisfiesMfa = (amr: unknown) => Array.isArray(amr) && amr.some((a) => (MFA_AMR as readonly string[]).includes(String(a)));

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

/** SCIM filters CREW answers: `userName eq "x"` and `externalId eq "x"` (what Okta and Entra ID send). */
export function parseScimFilter(filter: string | undefined): { attr: 'userName' | 'externalId'; value: string } | null | 'unsupported' {
  if (!filter) return null;
  const m = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) return 'unsupported';
  return { attr: m[1]!.toLowerCase() === 'username' ? 'userName' : 'externalId', value: m[2]!.replace(/\\(.)/g, '$1') };
}

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
  { area: 'Helpdesk cases they raised', action: 'erased', detail: 'Subject and messages they wrote replaced with "[erased]".' },
  { area: 'Payroll and payslips', action: 'kept', detail: 'Amounts kept, now linked to the pseudonymous record, because tax and labour law require payroll records to be kept for several years.' },
  { area: 'Attendance and leave', action: 'kept', detail: 'Kept against the pseudonymous record for wage and working-time records.' },
  { area: 'Audit trail', action: 'kept', detail: 'Kept unchanged: it is insert-only evidence of who did what, and its integrity chain would break if edited.' },
] as const;
