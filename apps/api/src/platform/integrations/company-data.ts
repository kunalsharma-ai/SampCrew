/**
 * Company data from the Brandfetch Brand API (https://docs.brandfetch.com/reference/brand-api), used only when a
 * Console admin asks for it on a client profile. The key lives in Console > Integrations (platform_integrations),
 * never in the environment. Only what Brandfetch returns is passed on, labelled with its source; nothing is guessed.
 */
export interface BrandApiKeys { apiKey: string; baseUrl: string | null }

export interface BrandFacts {
  domain: string;
  name: string | null;
  description: string | null;
  logoUrl: string | null;
  linkedin: string | null;
  foundedYear: number | null;
  city: string | null;
  country: string | null;
  employees: string | null;
  industries: string[];
}

export class CompanyDataError extends Error {}

/** example.com from https://www.example.com/about, or null when it is not a web address. */
export function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const host = new URL(/^https?:\/\//.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

interface BrandResponse {
  name?: string | null;
  domain?: string;
  description?: string | null;
  longDescription?: string | null;
  links?: { name?: string; url?: string }[];
  logos?: { type?: string; theme?: string; formats?: { src?: string; format?: string; width?: number }[] }[];
  company?: { foundedYear?: number | null; employees?: number | string | null; location?: { city?: string | null; country?: string | null; countryCode?: string | null } | null; industries?: { name?: string }[] } | null;
}

export async function fetchBrand(keys: BrandApiKeys, domain: string): Promise<BrandFacts> {
  if (!keys.apiKey) throw new CompanyDataError('Brandfetch has no API key');
  const base = (keys.baseUrl || 'https://api.brandfetch.io').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/v2/brands/${encodeURIComponent(domain)}`, { headers: { authorization: `Bearer ${keys.apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new CompanyDataError(`Could not reach Brandfetch: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new CompanyDataError('Brandfetch refused the API key');
  if (res.status === 404) throw new CompanyDataError(`Brandfetch has no company for ${domain}`);
  if (res.status === 429) throw new CompanyDataError('Brandfetch rate limit reached; try again later');
  if (!res.ok) throw new CompanyDataError(`Brandfetch answered ${res.status}`);
  const b = (await res.json().catch(() => ({}))) as BrandResponse;
  // An https logo: the "logo" type first, then a symbol or icon; PNG or SVG.
  const logos = b.logos ?? [];
  const pick = ['logo', 'symbol', 'icon'].map((t) => logos.find((l) => l.type === t)).find(Boolean);
  const src = pick?.formats?.find((f) => f.format === 'png' || f.format === 'svg')?.src ?? pick?.formats?.[0]?.src ?? null;
  const linkedin = b.links?.find((l) => (l.name ?? '').toLowerCase() === 'linkedin')?.url ?? null;
  const year = b.company?.foundedYear;
  return {
    domain,
    name: b.name?.trim() || null,
    description: (b.description ?? b.longDescription ?? '').trim().slice(0, 2000) || null,
    logoUrl: src && /^https:\/\//.test(src) && src.length <= 500 ? src : null,
    linkedin: linkedin && /^https?:\/\//.test(linkedin) ? linkedin.slice(0, 200) : null,
    foundedYear: typeof year === 'number' && year >= 1800 && year <= 2100 ? year : null,
    city: b.company?.location?.city?.trim() || null,
    country: b.company?.location?.countryCode?.toUpperCase().slice(0, 2) || null,
    employees: b.company?.employees != null ? String(b.company.employees) : null,
    industries: (b.company?.industries ?? []).map((i) => i.name ?? '').filter(Boolean).slice(0, 5),
  };
}
