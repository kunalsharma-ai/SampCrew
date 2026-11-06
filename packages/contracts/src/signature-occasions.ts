import { z } from 'zod';

/**
 * Festival, celebration and awareness-day wishes for email signatures: a ready-made library from around the world,
 * company banners (a library occasion with the company's own words, or a custom banner with an image or GIF) and each
 * person's own picks and message. On any day at most one banner is shown, so a signature never turns into a poster.
 */

/** When an occasion falls. Moon-calendar festivals are listed per year because their dates are announced locally. */
export type OccasionDate =
  | { kind: 'fixed'; month: number; day: number }
  | { kind: 'nth-weekday'; month: number; weekday: number; n: number } // n = -1 for the last one in the month
  | { kind: 'easter'; offset: number }
  | { kind: 'listed'; dates: Record<number, string> };

export interface Occasion {
  key: string;
  name: string;
  region: string;
  icon: string;
  message: string;
  bgColor: string;
  fgColor: string;
  date: OccasionDate;
  /** Days the wish shows before the day itself, and how many days the occasion lasts. */
  before: number;
  days: number;
}

const o = (key: string, name: string, region: string, icon: string, message: string, bgColor: string, date: OccasionDate, before = 3, days = 1, fgColor = '#FFFFFF'): Occasion =>
  ({ key, name, region, icon, message, bgColor, fgColor, date, before, days });
const fixed = (month: number, day: number): OccasionDate => ({ kind: 'fixed', month, day });
const listed = (dates: Record<number, string>): OccasionDate => ({ kind: 'listed', dates });

export const OCCASIONS: Occasion[] = [
  o('new-year', 'New Year', 'Worldwide', '🎆', 'Wishing you a happy and successful New Year!', '#1E3A8A', fixed(1, 1), 5, 3),
  o('makar-sankranti', 'Makar Sankranti and Pongal', 'India', '🪁', 'Happy Makar Sankranti and Pongal! May the harvest bring joy and plenty.', '#D97706', fixed(1, 14), 2, 2),
  o('republic-day-in', 'Republic Day (India)', 'India', '🇮🇳', 'Happy Republic Day!', '#0F766E', fixed(1, 26), 1),
  o('lunar-new-year', 'Lunar New Year', 'East and South-East Asia', '🧧', 'Happy Lunar New Year! Wishing you health and prosperity.', '#B91C1C', listed({ 2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26' }), 4, 3),
  o('ramadan', 'Ramadan', 'Worldwide', '🌙', 'Ramadan Kareem! Wishing you a blessed month.', '#14532D', listed({ 2026: '2026-02-18', 2027: '2027-02-08', 2028: '2028-01-28' }), 1, 7),
  o('womens-day', "International Women's Day", 'Worldwide', '💐', "Happy International Women's Day!", '#7E22CE', fixed(3, 8), 1),
  o('holi', 'Holi', 'India and Nepal', '🎨', 'Happy Holi! May your life be filled with colour and joy.', '#DB2777', listed({ 2026: '2026-03-04', 2027: '2027-03-22', 2028: '2028-03-11' }), 3, 1),
  o('nowruz', 'Nowruz', 'Iran, Central Asia and beyond', '🌷', 'Happy Nowruz! Wishing you a fresh and joyful new year.', '#15803D', fixed(3, 20), 3, 2),
  o('eid-al-fitr', 'Eid al-Fitr', 'Worldwide', '🌙', 'Eid Mubarak! Wishing you peace, joy and blessings.', '#065F46', listed({ 2026: '2026-03-20', 2027: '2027-03-10', 2028: '2028-02-27' }), 2, 3),
  o('easter', 'Easter', 'Worldwide', '🐣', 'Happy Easter! Wishing you a joyful spring.', '#A16207', { kind: 'easter', offset: 0 }, 3, 2),
  o('earth-day', 'Earth Day', 'Worldwide', '🌍', 'Happy Earth Day! Please consider the environment before printing this email.', '#166534', fixed(4, 22), 1),
  o('labour-day', 'Labour Day', 'Worldwide', '🛠️', 'Happy Labour Day! Thank you to everyone who keeps the world working.', '#B45309', fixed(5, 1), 1),
  o('mothers-day', "Mother's Day", 'Many countries', '💐', "Happy Mother's Day!", '#BE185D', { kind: 'nth-weekday', month: 5, weekday: 0, n: 2 }, 2),
  o('eid-al-adha', 'Eid al-Adha', 'Worldwide', '🐑', 'Eid al-Adha Mubarak! Wishing you and your family peace and happiness.', '#065F46', listed({ 2026: '2026-05-27', 2027: '2027-05-16', 2028: '2028-05-05' }), 2, 3),
  o('environment-day', 'World Environment Day', 'Worldwide', '🌱', 'Happy World Environment Day! Small steps make a big difference.', '#15803D', fixed(6, 5), 1),
  o('pride', 'Pride Month', 'Worldwide', '🏳️‍🌈', 'Celebrating Pride Month. Everyone belongs here.', '#6D28D9', fixed(6, 1), 0, 30),
  o('fathers-day', "Father's Day", 'Many countries', '👔', "Happy Father's Day!", '#1D4ED8', { kind: 'nth-weekday', month: 6, weekday: 0, n: 3 }, 2),
  o('yoga-day', 'International Day of Yoga', 'Worldwide', '🧘', 'Happy International Day of Yoga!', '#0E7490', fixed(6, 21), 1),
  o('canada-day', 'Canada Day', 'Canada', '🍁', 'Happy Canada Day!', '#B91C1C', fixed(7, 1), 1),
  o('independence-day-us', 'Independence Day (US)', 'United States', '🎆', 'Happy Fourth of July!', '#1E3A8A', fixed(7, 4), 1),
  o('independence-day-in', 'Independence Day (India)', 'India', '🇮🇳', 'Happy Independence Day!', '#C2410C', fixed(8, 15), 1),
  o('rosh-hashanah', 'Rosh Hashanah', 'Worldwide', '🍎', 'Shana Tova! Wishing you a sweet new year.', '#92400E', listed({ 2026: '2026-09-12', 2027: '2027-10-02', 2028: '2028-09-21' }), 2, 2),
  o('mid-autumn', 'Mid-Autumn Festival', 'East and South-East Asia', '🥮', 'Happy Mid-Autumn Festival! Wishing you a bright and happy reunion.', '#9A3412', listed({ 2026: '2026-09-25', 2027: '2027-09-15', 2028: '2028-10-03' }), 3),
  o('gandhi-jayanti', 'Gandhi Jayanti', 'India', '🕊️', 'Remembering Mahatma Gandhi on Gandhi Jayanti.', '#475569', fixed(10, 2), 1),
  o('halloween', 'Halloween', 'Many countries', '🎃', 'Happy Halloween!', '#C2410C', fixed(10, 31), 2),
  o('diwali', 'Diwali', 'India and worldwide', '🪔', 'Happy Diwali! May the festival of lights bring you joy, health and prosperity.', '#B45309', listed({ 2026: '2026-11-08', 2027: '2027-10-29', 2028: '2028-10-17' }), 4, 3),
  o('thanksgiving', 'Thanksgiving (US)', 'United States', '🦃', 'Happy Thanksgiving! Grateful for working with you.', '#92400E', { kind: 'nth-weekday', month: 11, weekday: 4, n: 4 }, 3, 2),
  o('hanukkah', 'Hanukkah', 'Worldwide', '🕎', 'Happy Hanukkah! Wishing you light and joy.', '#1E40AF', listed({ 2026: '2026-12-05', 2027: '2027-12-25', 2028: '2028-12-13' }), 1, 8),
  o('christmas', 'Christmas', 'Worldwide', '🎄', 'Merry Christmas and best wishes for the New Year!', '#166534', fixed(12, 25), 7, 2),
  o('season', "Season's greetings", 'Worldwide', '❄️', "Season's greetings! Wishing you a restful break and a happy New Year.", '#0F4C81', fixed(12, 20), 0, 12),
  o('kwanzaa', 'Kwanzaa', 'United States and worldwide', '🕯️', 'Happy Kwanzaa!', '#14532D', fixed(12, 26), 0, 7),
];

export const OCCASION_KEYS = OCCASIONS.map((x) => x.key) as [string, ...string[]];
export const occasionByKey = (key: string) => OCCASIONS.find((x) => x.key === key) ?? null;

/** Icons people can put on their own message. Desktop Outlook on Windows 10 and 11 shows them in colour. */
export const BANNER_ICONS = ['🎉', '🎊', '🎁', '🎆', '🪔', '🎄', '🌙', '🧧', '🌸', '🌷', '🌍', '⭐', '❤️', '🙏', '🏆', '🚀', '📣', '🎂', '☀️', '❄️', '🍁', '🕎', '🥮', '🎨'] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Western Easter Sunday (Anonymous Gregorian algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** The day an occasion falls on in a year, or null when its date for that year is not known yet. */
export function occasionDay(x: Occasion, year: number): string | null {
  const d = x.date;
  if (d.kind === 'fixed') return iso(year, d.month, d.day);
  if (d.kind === 'easter') return addDays(easterSunday(year), d.offset);
  if (d.kind === 'listed') return d.dates[year] ?? null;
  if (d.n > 0) {
    const first = new Date(Date.UTC(year, d.month - 1, 1)).getUTCDay();
    return iso(year, d.month, 1 + ((d.weekday - first + 7) % 7) + (d.n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, d.month, 0));
  return iso(year, d.month, lastDay.getUTCDate() - ((lastDay.getUTCDay() - d.weekday + 7) % 7));
}

/** The window the wish shows in, for the occasion that is current or next on or after `today`. */
export function occasionWindow(x: Occasion, today: string): { day: string; from: string; to: string } | null {
  const year = Number(today.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {
    const day = occasionDay(x, y);
    if (!day) continue;
    const from = addDays(day, -x.before), to = addDays(day, x.days - 1);
    if (to >= today) return { day, from, to };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------------

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1F6FEB');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-25');
const optional = <T extends z.ZodTypeAny>(s: T) => z.union([s, z.literal('')]).optional().transform((v) => (v === '' ? undefined : v));
export const bannerIcon = z.string().trim().max(16);
export const bannerMessage = z.string().trim().min(1, 'Write the message').max(200);

/** A company banner: a library occasion in the company's own words, or a custom banner with its own dates and image. */
export const signatureBannerInput = z.object({
  occasionKey: z.enum(OCCASION_KEYS).nullable().default(null),
  title: z.string().trim().min(1, 'Name the banner').max(80),
  message: bannerMessage,
  icon: optional(bannerIcon),
  bgColor: hex.default('#1F3A93'),
  fgColor: hex.default('#FFFFFF'),
  linkUrl: optional(z.string().trim().max(300).regex(/^https?:\/\/\S+$/i, 'Start the address with https://')),
  /** Custom banners need dates; occasions follow the library dates unless both are given. */
  startsOn: optional(date),
  endsOn: optional(date),
  position: z.enum(['above', 'below']).default('below'),
  enabled: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (!v.occasionKey && (!v.startsOn || !v.endsOn)) ctx.addIssue({ code: 'custom', path: ['startsOn'], message: 'Choose when the banner starts and ends' });
  if (!!v.startsOn !== !!v.endsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'Give both dates, or neither to follow the festival dates' });
  if (v.startsOn && v.endsOn && v.endsOn < v.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'The end is before the start' });
  if (v.startsOn && v.endsOn && (Date.parse(v.endsOn) - Date.parse(v.startsOn)) / 86_400_000 > 92) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'A banner can run for up to 3 months' });
});
export type SignatureBannerInput = z.infer<typeof signatureBannerInput>;

/** What each person chooses: company banners on or off, library occasions of their own, and their own message. */
export const signatureWishesInput = z.object({
  showCompany: z.boolean().default(true),
  occasions: z.array(z.enum(OCCASION_KEYS)).max(OCCASIONS.length).default([]),
  message: optional(z.string().trim().max(200)),
  icon: optional(bannerIcon),
  from: optional(date),
  to: optional(date),
}).strict().prefault({});
export type SignatureWishes = z.infer<typeof signatureWishesInput>;

// ---------------------------------------------------------------------------------------------------------------------
// Choosing today's banner
// ---------------------------------------------------------------------------------------------------------------------

/** A banner as the renderer draws it. */
export interface SignatureBannerView {
  message: string;
  icon?: string | null;
  bgColor: string;
  fgColor: string;
  imageSrc?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  linkUrl?: string | null;
  position?: 'above' | 'below';
}

/** A company banner as the API sends it to the signature page and uses for the sync. */
export interface CompanyBanner {
  id: string;
  occasionKey: string | null;
  title: string;
  message: string;
  icon: string | null;
  bgColor: string;
  fgColor: string;
  linkUrl: string | null;
  startsOn: string | null;
  endsOn: string | null;
  position: 'above' | 'below';
  enabled: boolean;
  image: { updatedAt: string; width: number; height: number; contentType: string } | null;
}

/** When a company banner shows around `today`: its own dates, or its festival's. */
export function bannerWindow(b: Pick<CompanyBanner, 'occasionKey' | 'startsOn' | 'endsOn'>, today: string): { from: string; to: string } | null {
  if (b.startsOn && b.endsOn) return { from: b.startsOn, to: b.endsOn };
  const x = b.occasionKey ? occasionByKey(b.occasionKey) : null;
  return x ? occasionWindow(x, today) : null;
}

export type BannerSource = { kind: 'company'; banner: CompanyBanner } | { kind: 'occasion'; occasion: Occasion } | { kind: 'own' };

/**
 * The banner for `today`, if any. Company banners come first (custom ones before festival ones, then the soonest to
 * end), then the person's own festival picks, then their own message.
 */
export function pickBanner(today: string, company: CompanyBanner[], wishes: SignatureWishes): { source: BannerSource; view: Omit<SignatureBannerView, 'imageSrc'> } | null {
  if (wishes.showCompany) {
    const live = company
      .filter((b) => b.enabled)
      .map((b) => ({ b, w: bannerWindow(b, today) }))
      .filter((x): x is { b: CompanyBanner; w: { from: string; to: string } } => !!x.w && x.w.from <= today && today <= x.w.to)
      .sort((p, q) => Number(!!p.b.occasionKey) - Number(!!q.b.occasionKey) || p.w.to.localeCompare(q.w.to) || p.b.id.localeCompare(q.b.id));
    const b = live[0]?.b;
    if (b) {
      return {
        source: { kind: 'company', banner: b },
        view: { message: b.message, icon: b.icon, bgColor: b.bgColor, fgColor: b.fgColor, linkUrl: b.linkUrl, position: b.position, imageWidth: b.image?.width ?? null, imageHeight: b.image?.height ?? null },
      };
    }
  }
  const covered = new Set(company.filter((b) => b.enabled && b.occasionKey).map((b) => b.occasionKey));
  const mine = wishes.occasions
    .map(occasionByKey)
    .filter((x): x is Occasion => !!x && !(wishes.showCompany && covered.has(x.key)))
    .map((x) => ({ x, w: occasionWindow(x, today) }))
    .filter((p) => p.w && p.w.from <= today && today <= p.w.to)
    .sort((p, q) => p.w!.to.localeCompare(q.w!.to));
  if (mine[0]) {
    const x = mine[0].x;
    return { source: { kind: 'occasion', occasion: x }, view: { message: x.message, icon: x.icon, bgColor: x.bgColor, fgColor: x.fgColor, position: 'below' } };
  }
  if (wishes.message && (!wishes.from || wishes.from <= today) && (!wishes.to || today <= wishes.to)) {
    return { source: { kind: 'own' }, view: { message: wishes.message, icon: wishes.icon ?? null, bgColor: '', fgColor: '', position: 'below' } };
  }
  return null;
}

/** Today's date where the person is, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
