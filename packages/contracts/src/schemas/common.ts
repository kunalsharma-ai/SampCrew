import { z } from 'zod';

export const uuid = z.uuid();

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  q: z.string().trim().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO country code, for example IN');
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code, for example INR');
export const timezone = z.string().min(1).max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');
export const locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Use a locale such as en or en-IN');
export const slug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Lowercase letters, numbers and hyphens only');
export const code = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_.-]+$/, 'Letters, numbers, dot, dash and underscore only');
export const name = z.string().trim().min(1).max(160);

/** Trims and lower-cases before validating, so ' Asha@Acme.com ' is accepted as 'asha@acme.com'. */
export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
