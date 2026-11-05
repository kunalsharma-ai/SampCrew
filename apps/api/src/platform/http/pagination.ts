import { Errors } from './errors';

/** Opaque keyset cursor: base64url(JSON [sortValue, id]). Stable under concurrent inserts, good for mobile infinite scroll. */
export function encodeCursor(sortValue: string | number, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2) return [String(v[0]), String(v[1])];
  } catch {
    /* fall through */
  }
  throw Errors.badRequest('invalid_cursor', 'The pagination cursor is invalid');
}

export function page<T extends { id: string }>(rows: T[], limit: number, sortKey: (row: T) => string | number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(sortKey(last), last.id) : null };
}
