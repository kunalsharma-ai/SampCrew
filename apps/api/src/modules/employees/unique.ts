import { Errors } from '../../platform/http/errors';

/** Turns a unique-index clash into a 409 with this code and message; other errors pass through. */
export function uniqueAs(code: string, message: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === '23505') throw Errors.conflict(code, message);
    throw err;
  };
}
