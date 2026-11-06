import { z } from 'zod';
import { type SignatureBannerView, signatureWishesInput } from './signature-occasions';

/**
 * Email signatures for Outlook. One renderer turns a person's details and their chosen design into the HTML and plain
 * text that Outlook stores in %APPDATA%\Microsoft\Signatures. The web preview and the Windows sync use the same code,
 * so what people see in SampCrew is what Outlook gets.
 *
 * Outlook 2013 and later draw HTML with Word's engine, so every design sticks to what it reliably supports: tables for
 * layout, inline styles only, web-safe fonts, images with explicit width and height, no CSS backgrounds on <div>, no
 * flexbox, no SVG and no web fonts. Social links are text, because icon images are often blocked or shown as
 * attachments.
 */

export const SIGNATURE_FONTS = ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Verdana', 'Georgia', 'Times New Roman', 'Trebuchet MS'] as const;
export type SignatureFont = (typeof SIGNATURE_FONTS)[number];
export const SIGNATURE_SIZES = ['small', 'medium', 'large'] as const;
export const SIGNATURE_SYNC_MODES = ['auto', 'manual'] as const;
export type SignatureSyncMode = (typeof SIGNATURE_SYNC_MODES)[number];
export const SOCIAL_NETWORKS = ['linkedin', 'x', 'facebook', 'instagram', 'youtube'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
const SOCIAL_LABEL: Record<SocialNetwork, string> = { linkedin: 'LinkedIn', x: 'X', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' };

export const SIGNATURE_TEMPLATES = [
  { key: 'classic', name: 'Classic', description: 'Name, title and company over your contact lines. Fits any company.' },
  { key: 'photo-left', name: 'Photo left', description: 'Your photo on the left with a brand-coloured bar beside your details.' },
  { key: 'one-line', name: 'One line', description: 'Everything on a single line. Short and quiet, good for replies.' },
  { key: 'logo-top', name: 'Logo on top', description: 'Company logo first, then your details underneath.' },
  { key: 'banner', name: 'Banner', description: 'Your name in a solid brand-coloured strip, contacts below.' },
  { key: 'minimal', name: 'Minimal', description: 'Small grey text with no colour. For people who like it plain.' },
  { key: 'bold-name', name: 'Bold name', description: 'A large name with an accent underline.' },
  { key: 'logo-divider', name: 'Logo and divider', description: 'Logo on the left, a thin vertical line, your details on the right.' },
  { key: 'card', name: 'Business card', description: 'Your details inside a bordered card, like a printed business card.' },
  { key: 'centered', name: 'Centred', description: 'Everything centred, with the logo underneath.' },
  { key: 'two-column', name: 'Two columns', description: 'Name and title on the left, how to reach you on the right.' },
  { key: 'executive', name: 'Executive', description: 'Serif type and generous spacing for a formal look.' },
  { key: 'accent-border', name: 'Accent border', description: 'A thick brand-coloured line down the left side.' },
  { key: 'photo-top', name: 'Photo on top', description: 'A large photo above your name, everything centred.' },
  { key: 'labels', name: 'Labelled', description: 'Short labels (P, M, E, W) in the accent colour before each contact.' },
  { key: 'footer-band', name: 'Footer band', description: 'Your details with a brand-coloured band carrying the website underneath.' },
  { key: 'social', name: 'Social first', description: 'Your social profiles shown as a row of coloured links.' },
  { key: 'call-to-action', name: 'Call to action', description: 'Adds a button-style link, for example to book a meeting.' },
  { key: 'disclaimer', name: 'With disclaimer', description: 'Your details and the company disclaimer in a shaded box.' },
  { key: 'warm', name: 'Warm sign-off', description: 'Starts with a friendly sign-off line above your name.' },
] as const;
export type SignatureTemplateKey = (typeof SIGNATURE_TEMPLATES)[number]['key'];
export const SIGNATURE_TEMPLATE_KEYS = SIGNATURE_TEMPLATES.map((t) => t.key) as [SignatureTemplateKey, ...SignatureTemplateKey[]];

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1F6FEB');
const url = z.string().trim().max(300).regex(/^https?:\/\/\S+$/i, 'Start the address with https://');
const short = (max: number) => z.string().trim().max(max);
const optional = <T extends z.ZodTypeAny>(s: T) => z.union([s, z.literal('')]).optional().transform((v) => (v === '' ? undefined : v));
const socialInput = z.object({ linkedin: optional(url), x: optional(url), facebook: optional(url), instagram: optional(url), youtube: optional(url) }).strict();

/** What each person can change about their own signature. Company details come from the workspace. */
export const signatureOptionsInput = z.object({
  brandColor: optional(hex),
  accentColor: optional(hex),
  font: z.enum(SIGNATURE_FONTS).default('Arial'),
  size: z.enum(SIGNATURE_SIZES).default('medium'),
  show: z.object({
    photo: z.boolean().default(true),
    logo: z.boolean().default(true),
    department: z.boolean().default(false),
    phone: z.boolean().default(true),
    mobile: z.boolean().default(true),
    email: z.boolean().default(true),
    website: z.boolean().default(true),
    address: z.boolean().default(false),
    social: z.boolean().default(true),
    disclaimer: z.boolean().default(true),
  }).prefault({}),
  /** Overrides: empty means "use what HR has on record". */
  jobTitle: optional(short(120)),
  phone: optional(short(40)),
  mobile: optional(short(40)),
  pronouns: optional(short(30)),
  signOff: optional(short(60)),
  tagline: optional(short(160)),
  ctaLabel: optional(short(40)),
  ctaUrl: optional(url),
  social: socialInput.prefault({}),
  /** Festival and celebration wishes: company banners, the person's own festival picks and their own message. */
  wishes: signatureWishesInput,
}).strict();
export type SignatureOptions = z.infer<typeof signatureOptionsInput>;

export const saveSignatureInput = z.object({
  template: z.enum(SIGNATURE_TEMPLATE_KEYS),
  options: signatureOptionsInput,
  /** null follows the company default. */
  syncMode: z.enum(SIGNATURE_SYNC_MODES).nullable().default(null),
}).strict();
export type SaveSignatureInput = z.infer<typeof saveSignatureInput>;

/** Company-wide signature details, set by people who manage the organisation. */
export const signatureSettingsInput = z.object({
  companyName: optional(short(160)),
  website: optional(url),
  phone: optional(short(40)),
  address: optional(short(300)),
  brandColor: hex.default('#1F3A93'),
  accentColor: hex.default('#E8833A'),
  defaultTemplate: z.enum(SIGNATURE_TEMPLATE_KEYS).default('classic'),
  disclaimer: optional(short(1000)),
  social: socialInput.prefault({}),
  syncMode: z.enum(SIGNATURE_SYNC_MODES).default('auto'),
  /** When false, everyone follows the company's sync mode. */
  allowEmployeeSyncChoice: z.boolean().default(true),
  /** When true, people keep the company design and can only change their own text and what is shown. */
  lockTemplate: z.boolean().default(false),
}).strict();
export type SignatureSettingsInput = z.infer<typeof signatureSettingsInput>;

/** What the Windows sync reports back after writing the signature. */
export const signatureAgentReport = z.object({
  version: z.string().regex(/^[0-9a-f]{16,64}$/),
  ok: z.boolean(),
  error: z.string().max(500).optional(),
  outlookVersions: z.array(z.string().max(10)).max(5).optional(),
}).strict();
export const signatureAgentSyncInput = z.object({
  /** The version the computer has now, so an unchanged signature is not sent again. */
  currentVersion: z.string().max(64).optional(),
  trigger: z.enum(['install', 'scheduled', 'manual']).default('scheduled'),
  computerName: z.string().max(64).optional(),
  outlookVersions: z.array(z.string().max(10)).max(5).optional(),
  agentVersion: z.string().max(20).optional(),
}).strict();

// ---------------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------------

export interface SignatureData {
  fullName: string;
  jobTitle?: string | null;
  department?: string | null;
  pronouns?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  website?: string | null;
  address?: string | null;
  /** Image addresses: a URL in the web preview, a file next to the .htm on the computer. */
  photoSrc?: string | null;
  logoSrc?: string | null;
  logoWidth?: number | null;
  logoHeight?: number | null;
  social?: Partial<Record<SocialNetwork, string>>;
  disclaimer?: string | null;
  tagline?: string | null;
  signOff?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  /** Today's festival wish or message, if any. */
  banner?: SignatureBannerView | null;
  brandColor: string;
  accentColor: string;
  font: SignatureFont;
  size: (typeof SIGNATURE_SIZES)[number];
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u: string | null | undefined) => (u && /^(https?:\/\/|mailto:|tel:)/i.test(u) ? u : null);
/** An image address may be a web address, a path on the same site or a file name next to the signature. */
const safeImg = (u: string | null | undefined) => (u && /^(https?:\/\/|\/[^/]|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$)/.test(u) && !/["'<>\s]/.test(u) ? u : null);
const telHref = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;
const bare = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/$/, '');

interface Ctx {
  d: SignatureData;
  font: string;
  base: number;
  fg: string;
  muted: string;
}

function ctx(d: SignatureData): Ctx {
  const base = d.size === 'small' ? 12 : d.size === 'large' ? 15 : 13;
  const fallback = ['Georgia', 'Times New Roman'].includes(d.font) ? 'serif' : 'sans-serif';
  return { d, font: `'${d.font}', ${fallback}`, base, fg: '#222222', muted: '#666666' };
}

const t = (c: Ctx, extra = '') => `font-family:${c.font};font-size:${c.base}px;line-height:1.4;color:${c.fg};${extra}`;
const a = (c: Ctx, href: string, label: string, color?: string, extra = '') =>
  `<a href="${esc(href)}" style="color:${color ?? c.d.brandColor};text-decoration:none;${extra}">${esc(label)}</a>`;
const table = (inner: string, extra = '') => `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;${extra}">${inner}</table>`;

function nameLine(c: Ctx, size = 1.3, color?: string) {
  const p = c.d.pronouns ? ` <span style="font-weight:normal;font-size:${c.base - 1}px;color:${c.muted};">(${esc(c.d.pronouns)})</span>` : '';
  return `<span style="${t(c, `font-size:${Math.round(c.base * size)}px;font-weight:bold;color:${color ?? c.fg};`)}">${esc(c.d.fullName)}</span>${p}`;
}
function titleLine(c: Ctx, color?: string) {
  const bits = [c.d.jobTitle, c.d.department].filter(Boolean) as string[];
  return bits.length ? `<span style="${t(c, `color:${color ?? c.muted};`)}">${esc(bits.join(', '))}</span>` : '';
}
function companyLine(c: Ctx, color?: string) {
  return c.d.company ? `<span style="${t(c, `font-weight:bold;color:${color ?? c.d.brandColor};`)}">${esc(c.d.company)}</span>` : '';
}
function photo(c: Ctx, size: number, round = true) {
  const src = safeImg(c.d.photoSrc);
  return src ? `<img src="${esc(src)}" width="${size}" height="${size}" alt="${esc(c.d.fullName)}" style="display:block;width:${size}px;height:${size}px;border:0;${round ? `border-radius:${size / 2}px;` : ''}">` : '';
}
function logo(c: Ctx, height = 40) {
  const src = safeImg(c.d.logoSrc);
  if (!src) return '';
  const w = c.d.logoWidth && c.d.logoHeight ? Math.max(1, Math.round((c.d.logoWidth * height) / c.d.logoHeight)) : height * 3;
  return `<img src="${esc(src)}" width="${w}" height="${height}" alt="${esc(c.d.company ?? 'Logo')}" style="display:block;width:${w}px;height:${height}px;border:0;">`;
}

type Contact = { key: 'phone' | 'mobile' | 'email' | 'website' | 'address'; label: string; text: string; href: string | null };
function contacts(c: Ctx): Contact[] {
  const d = c.d;
  const out: Contact[] = [];
  if (d.phone) out.push({ key: 'phone', label: 'P', text: d.phone, href: telHref(d.phone) });
  if (d.mobile) out.push({ key: 'mobile', label: 'M', text: d.mobile, href: telHref(d.mobile) });
  if (d.email) out.push({ key: 'email', label: 'E', text: d.email, href: `mailto:${d.email}` });
  if (d.website && safeUrl(d.website)) out.push({ key: 'website', label: 'W', text: bare(d.website), href: d.website });
  if (d.address) out.push({ key: 'address', label: 'A', text: d.address, href: null });
  return out;
}
const contactText = (c: Ctx, x: Contact, color?: string) => (x.href ? a(c, x.href, x.text, color ?? c.fg) : `<span style="${t(c, color ? `color:${color};` : '')}">${esc(x.text)}</span>`);
function contactLines(c: Ctx, opts: { labels?: boolean; color?: string; sep?: string } = {}) {
  return contacts(c)
    .map((x) => `<span style="${t(c)}">${opts.labels ? `<span style="font-weight:bold;color:${c.d.accentColor};">${x.label}</span>&nbsp;` : ''}${contactText(c, x, opts.color)}</span>`)
    .join(opts.sep ?? '<br>');
}
function socialLinks(c: Ctx, style: 'text' | 'pills' = 'text') {
  const links = SOCIAL_NETWORKS.map((n) => [n, safeUrl(c.d.social?.[n])] as const).filter(([, u]) => u) as [SocialNetwork, string][];
  if (!links.length) return '';
  if (style === 'pills') {
    return table(`<tr>${links.map(([n, u]) => `<td style="padding:0 6px 0 0;"><table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td bgcolor="${c.d.brandColor}" style="background-color:${c.d.brandColor};padding:3px 8px;">${a(c, u, SOCIAL_LABEL[n], '#ffffff', `font-family:${c.font};font-size:${c.base - 1}px;font-weight:bold;`)}</td></tr></table></td>`).join('')}</tr>`);
  }
  return `<span style="${t(c)}">${links.map(([n, u]) => a(c, u, SOCIAL_LABEL[n], c.d.accentColor, 'font-weight:bold;')).join(' &nbsp;|&nbsp; ')}</span>`;
}
function tagline(c: Ctx) {
  return c.d.tagline ? `<span style="${t(c, `font-style:italic;color:${c.muted};`)}">${esc(c.d.tagline)}</span>` : '';
}
function disclaimer(c: Ctx, boxed = false) {
  if (!c.d.disclaimer) return '';
  const inner = `<span style="${t(c, `font-size:${Math.max(9, c.base - 3)}px;color:#888888;`)}">${esc(c.d.disclaimer).replace(/\n/g, '<br>')}</span>`;
  return boxed ? table(`<tr><td bgcolor="#F3F4F6" style="background-color:#F3F4F6;padding:8px 10px;border-left:3px solid ${c.d.accentColor};">${inner}</td></tr>`, 'margin-top:10px;max-width:560px;') : `<div style="margin-top:10px;max-width:560px;">${inner}</div>`;
}
function cta(c: Ctx) {
  const u = safeUrl(c.d.ctaUrl);
  if (!u) return '';
  return table(`<tr><td bgcolor="${c.d.accentColor}" style="background-color:${c.d.accentColor};padding:7px 14px;">${a(c, u, c.d.ctaLabel || 'Book a meeting', '#ffffff', `font-family:${c.font};font-size:${c.base}px;font-weight:bold;`)}</td></tr>`, 'margin-top:8px;');
}
/** Today's wish: the banner image (a GIF plays in Outlook for Microsoft 365) or a coloured strip with an icon. */
function banner(c: Ctx) {
  const b = c.d.banner;
  if (!b || !b.message) return '';
  const link = safeUrl(b.linkUrl);
  const src = safeImg(b.imageSrc);
  if (src) {
    const w0 = b.imageWidth ?? 480, h0 = b.imageHeight ?? 120;
    const w = Math.min(480, w0), h = Math.max(1, Math.round((h0 * w) / w0));
    const img = `<img src="${esc(src)}" width="${w}" height="${h}" alt="${esc(b.message)}" style="display:block;width:${w}px;height:${h}px;border:0;">`;
    return link ? `<a href="${esc(link)}" style="text-decoration:none;">${img}</a>` : img;
  }
  const bg = /^#[0-9a-fA-F]{6}$/.test(b.bgColor) ? b.bgColor : c.d.brandColor;
  const fg = /^#[0-9a-fA-F]{6}$/.test(b.fgColor) ? b.fgColor : '#FFFFFF';
  const icon = b.icon ? `<span style="font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;font-size:${c.base + 5}px;">${esc(b.icon)}</span>&nbsp;&nbsp;` : '';
  const text = `${icon}<span style="font-family:${c.font};font-size:${c.base}px;font-weight:bold;color:${fg};">${esc(b.message)}</span>`;
  return table(`<tr><td bgcolor="${bg}" style="background-color:${bg};padding:8px 14px;">${link ? a(c, link, '', fg).replace('></a>', `>${text}</a>`) : text}</td></tr>`, 'max-width:480px;');
}

/** Joins non-empty parts with line breaks. */
const lines = (...parts: string[]) => parts.filter(Boolean).join('<br>');
const block = (...parts: string[]) => parts.filter(Boolean).map((p) => `<div style="margin-top:6px;">${p}</div>`).join('');
const tail = (c: Ctx) => block(socialLinks(c), tagline(c)) + disclaimer(c);

const TEMPLATES: Record<SignatureTemplateKey, (c: Ctx) => string> = {
  classic: (c) => lines(nameLine(c), titleLine(c), companyLine(c)) + block(contactLines(c)) + block(logo(c)) + tail(c),

  'photo-left': (c) =>
    table(`<tr>${photo(c, 80) ? `<td valign="top" style="padding:0 12px 0 0;">${photo(c, 80)}</td>` : ''}<td valign="top" style="border-left:3px solid ${c.d.brandColor};padding:0 0 0 12px;">${lines(nameLine(c), titleLine(c), companyLine(c))}${block(contactLines(c))}</td></tr>`) + block(logo(c)) + tail(c),

  'one-line': (c) =>
    `<span style="${t(c)}">${[nameLine(c, 1), c.d.jobTitle ? esc(c.d.jobTitle) : '', c.d.company ? `<span style="color:${c.d.brandColor};font-weight:bold;">${esc(c.d.company)}</span>` : '', ...contacts(c).filter((x) => x.key !== 'address').map((x) => contactText(c, x))].filter(Boolean).join(` <span style="color:${c.d.accentColor};">|</span> `)}</span>` + disclaimer(c),

  'logo-top': (c) => (logo(c) ? `<div style="margin-bottom:8px;">${logo(c, 44)}</div>` : '') + lines(nameLine(c), titleLine(c), companyLine(c)) + block(contactLines(c)) + tail(c),

  banner: (c) =>
    table(`<tr><td bgcolor="${c.d.brandColor}" style="background-color:${c.d.brandColor};padding:8px 14px;">${nameLine(c, 1.25, '#ffffff')}${c.d.jobTitle ? `<br><span style="${t(c, 'color:#ffffff;')}">${esc([c.d.jobTitle, c.d.company].filter(Boolean).join(' · '))}</span>` : ''}</td></tr><tr><td style="padding:8px 14px;border-bottom:3px solid ${c.d.accentColor};">${contactLines(c, { sep: ' &nbsp;·&nbsp; ' })}</td></tr>`, 'min-width:320px;') + block(logo(c)) + tail(c),

  minimal: (c) => {
    const m: Ctx = { ...c, fg: '#555555', base: c.base - 1 };
    return `<div style="${t(m)}">${lines(`<span style="font-weight:bold;color:#333333;">${esc(c.d.fullName)}</span>`, esc([c.d.jobTitle, c.d.company].filter(Boolean).join(', ')), contacts(m).map((x) => contactText(m, x, '#555555')).join(' · '))}</div>` + tail(m);
  },

  'bold-name': (c) =>
    `<div style="padding-bottom:4px;border-bottom:3px solid ${c.d.accentColor};display:inline-block;">${nameLine(c, 1.8, c.d.brandColor)}</div>` + block(lines(titleLine(c, c.fg), companyLine(c)), contactLines(c)) + block(logo(c)) + tail(c),

  'logo-divider': (c) =>
    table(`<tr>${logo(c) ? `<td valign="middle" style="padding:0 14px 0 0;">${logo(c, 48)}</td><td style="border-left:1px solid #cccccc;padding:0 14px 0 0;">&nbsp;</td>` : ''}<td valign="middle">${lines(nameLine(c), titleLine(c), companyLine(c))}${block(contactLines(c))}</td></tr>`) + tail(c),

  card: (c) =>
    table(`<tr><td style="border:1px solid #d9d9d9;border-top:4px solid ${c.d.brandColor};padding:12px 16px;">${table(`<tr>${photo(c, 64) ? `<td valign="top" style="padding:0 12px 0 0;">${photo(c, 64)}</td>` : ''}<td valign="top">${lines(nameLine(c), titleLine(c), companyLine(c))}${block(contactLines(c))}</td>${logo(c) ? `<td valign="bottom" style="padding:0 0 0 16px;">${logo(c, 32)}</td>` : ''}</tr>`)}</td></tr>`) + tail(c),

  centered: (c) =>
    `<div style="text-align:center;">${lines(nameLine(c), titleLine(c), companyLine(c))}${block(contactLines(c, { sep: ' &nbsp;·&nbsp; ' }))}${logo(c) ? `<div style="margin-top:8px;">${table(`<tr><td align="center">${logo(c)}</td></tr>`, 'margin:0 auto;')}</div>` : ''}${block(socialLinks(c), tagline(c))}</div>` + disclaimer(c),

  'two-column': (c) =>
    table(`<tr><td valign="top" style="padding:0 18px 0 0;border-right:2px solid ${c.d.accentColor};">${lines(nameLine(c), titleLine(c), companyLine(c))}${logo(c) ? `<div style="margin-top:8px;">${logo(c, 32)}</div>` : ''}</td><td valign="top" style="padding:0 0 0 18px;">${contactLines(c, { labels: true })}</td></tr>`) + tail(c),

  executive: (c) => {
    const e: Ctx = { ...c, font: c.d.font === 'Georgia' || c.d.font === 'Times New Roman' ? c.font : `'Georgia', serif` };
    return `<div style="${t(e, 'letter-spacing:0.3px;')}">${lines(`<span style="${t(e, `font-size:${Math.round(e.base * 1.4)}px;color:${c.d.brandColor};`)}">${esc(c.d.fullName)}</span>`, c.d.jobTitle ? `<span style="${t(e, `font-style:italic;color:${e.muted};`)}">${esc(c.d.jobTitle)}</span>` : '', c.d.company ? `<span style="${t(e, 'text-transform:uppercase;letter-spacing:2px;font-size:' + (e.base - 1) + 'px;')}">${esc(c.d.company)}</span>` : '')}</div><div style="margin:8px 0;width:60px;border-top:1px solid ${c.d.accentColor};font-size:1px;line-height:1px;">&nbsp;</div>${contactLines(e)}` + block(logo(e)) + tail(e);
  },

  'accent-border': (c) =>
    table(`<tr><td style="border-left:6px solid ${c.d.brandColor};padding:2px 0 2px 14px;">${lines(nameLine(c), titleLine(c), companyLine(c, c.d.accentColor))}${block(contactLines(c))}${block(logo(c, 32))}</td></tr>`) + tail(c),

  'photo-top': (c) =>
    `<div style="text-align:center;">${photo(c, 96) ? table(`<tr><td align="center">${photo(c, 96)}</td></tr>`, 'margin:0 auto 8px auto;') : ''}${lines(nameLine(c), titleLine(c), companyLine(c))}${block(contactLines(c))}${block(socialLinks(c), tagline(c))}</div>` + disclaimer(c),

  labels: (c) => lines(nameLine(c), titleLine(c), companyLine(c)) + block(contactLines(c, { labels: true })) + block(logo(c)) + tail(c),

  'footer-band': (c) => {
    const w = safeUrl(c.d.website);
    return lines(nameLine(c), titleLine(c), companyLine(c)) + block(contactLines(c)) + table(`<tr><td bgcolor="${c.d.brandColor}" style="background-color:${c.d.brandColor};padding:6px 12px;">${w ? a(c, w, bare(w), '#ffffff', `font-family:${c.font};font-size:${c.base}px;font-weight:bold;`) : `<span style="${t(c, 'color:#ffffff;font-weight:bold;')}">${esc(c.d.company ?? c.d.fullName)}</span>`}</td></tr>`, 'margin-top:10px;min-width:320px;') + tail(c);
  },

  social: (c) =>
    table(`<tr>${photo(c, 64) ? `<td valign="top" style="padding:0 12px 0 0;">${photo(c, 64)}</td>` : ''}<td valign="top">${lines(nameLine(c), titleLine(c), companyLine(c))}${block(contactLines(c, { sep: ' &nbsp;·&nbsp; ' }))}</td></tr>`) + (socialLinks(c, 'pills') ? `<div style="margin-top:8px;">${socialLinks(c, 'pills')}</div>` : '') + block(tagline(c)) + disclaimer(c),

  'call-to-action': (c) => lines(nameLine(c), titleLine(c), companyLine(c)) + block(contactLines(c)) + cta(c) + block(logo(c)) + tail(c),

  disclaimer: (c) => lines(nameLine(c), titleLine(c), companyLine(c)) + block(contactLines(c)) + block(logo(c)) + block(socialLinks(c), tagline(c)) + disclaimer(c, true),

  warm: (c) =>
    `<span style="${t(c, `color:${c.muted};`)}">${esc(c.d.signOff || 'Warm regards,')}</span><br><br>` + lines(nameLine(c, 1.3, c.d.brandColor), titleLine(c), companyLine(c, c.fg)) + block(contactLines(c)) + block(logo(c)) + tail(c),
};

/** The signature as Outlook stores it: a full HTML document and the plain-text version. */
export function renderSignature(template: SignatureTemplateKey, d: SignatureData): { html: string; text: string; body: string } {
  const c = ctx(d);
  const b = banner(c);
  const above = b && d.banner?.position === 'above';
  const body = `<div style="${t(c)}">${above ? `<div style="margin-bottom:10px;">${b}</div>` : ''}${(TEMPLATES[template] ?? TEMPLATES.classic)(c)}${b && !above ? `<div style="margin-top:12px;">${b}</div>` : ''}</div>`;
  const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="Generator" content="SampCrew"></head><body>${body}</body></html>`;
  return { html, text: renderSignatureText(template, d), body };
}

export function renderSignatureText(template: SignatureTemplateKey, d: SignatureData): string {
  const out: string[] = [];
  if (template === 'warm') out.push(d.signOff || 'Warm regards,', '');
  out.push(d.pronouns ? `${d.fullName} (${d.pronouns})` : d.fullName);
  const title = [d.jobTitle, d.department].filter(Boolean).join(', ');
  if (title) out.push(title);
  if (d.company) out.push(d.company);
  const c = ctx(d);
  for (const x of contacts(c)) out.push(`${({ phone: 'Phone', mobile: 'Mobile', email: 'Email', website: 'Web', address: 'Address' })[x.key]}: ${x.key === 'website' ? d.website : x.text}`);
  const social = SOCIAL_NETWORKS.filter((n) => safeUrl(d.social?.[n])).map((n) => `${SOCIAL_LABEL[n]}: ${d.social![n]}`);
  out.push(...social);
  if (template === 'call-to-action' && safeUrl(d.ctaUrl)) out.push(`${d.ctaLabel || 'Book a meeting'}: ${d.ctaUrl}`);
  if (d.tagline) out.push('', d.tagline);
  if (d.banner?.message) out.push('', [d.banner.icon, d.banner.message].filter(Boolean).join(' ') + (safeUrl(d.banner.linkUrl) ? ` ${d.banner.linkUrl}` : ''));
  if (d.disclaimer) out.push('', d.disclaimer);
  return out.join('\r\n');
}

/** Sample details for the design gallery. */
export const SAMPLE_SIGNATURE: Omit<SignatureData, 'brandColor' | 'accentColor' | 'font' | 'size'> = {
  fullName: 'Priya Sharma',
  jobTitle: 'Senior HR Manager',
  department: 'Human Resources',
  company: 'Northwind Manufacturing',
  email: 'priya.sharma@northwind.example',
  phone: '+91 20 5555 0100',
  mobile: '+91 98765 43210',
  website: 'https://northwind.example',
  address: 'Plot 4, MIDC, Pune 411019',
  social: { linkedin: 'https://www.linkedin.com/company/northwind', x: 'https://x.com/northwind' },
  tagline: 'Building great teams, one hire at a time.',
  ctaLabel: 'Book a meeting',
  ctaUrl: 'https://northwind.example/meet',
  disclaimer: 'This email and any attachments are confidential and intended only for the person named above.',
};

/**
 * What HR and the company have on record for one person, before their own choices are applied. The API sends this
 * to the signature page so the live preview applies unsaved choices with exactly the same rules as the sync.
 */
export interface SignatureBase {
  fullName: string;
  designation: string | null;
  department: string | null;
  company: string | null;
  email: string | null;
  /** The company's phone, used unless the person enters their own. */
  phone: string | null;
  /** The person's phone on record, used as the mobile unless they enter another. */
  mobile: string | null;
  website: string | null;
  address: string | null;
  disclaimer: string | null;
  social: Partial<Record<SocialNetwork, string>>;
  brandColor: string;
  accentColor: string;
  logoWidth: number | null;
  logoHeight: number | null;
}

/** The person's record with their own choices applied. Images are added by the caller (web links or files). */
export function composeSignatureData(b: SignatureBase, o: SignatureOptions): Omit<SignatureData, 'photoSrc' | 'logoSrc'> {
  const show = o.show;
  const own = Object.fromEntries(Object.entries(o.social ?? {}).filter(([, v]) => v)) as Partial<Record<SocialNetwork, string>>;
  return {
    fullName: b.fullName,
    jobTitle: o.jobTitle ?? b.designation,
    department: show.department ? b.department : null,
    pronouns: o.pronouns ?? null,
    company: b.company,
    email: show.email ? b.email : null,
    phone: show.phone ? (o.phone ?? b.phone) : null,
    mobile: show.mobile ? (o.mobile ?? b.mobile) : null,
    website: show.website ? b.website : null,
    address: show.address ? b.address : null,
    logoWidth: b.logoWidth,
    logoHeight: b.logoHeight,
    social: show.social ? { ...b.social, ...own } : {},
    disclaimer: show.disclaimer ? b.disclaimer : null,
    tagline: o.tagline ?? null,
    signOff: o.signOff ?? null,
    ctaLabel: o.ctaLabel ?? null,
    ctaUrl: o.ctaUrl ?? null,
    brandColor: o.brandColor ?? b.brandColor,
    accentColor: o.accentColor ?? b.accentColor,
    font: o.font,
    size: o.size,
  };
}
