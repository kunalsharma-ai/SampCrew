import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { Errors } from './errors';

/** Validates a body/query/param with a zod schema from @crew/contracts. Usage: @Body(new ZodPipe(schema)). */
@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(public readonly schema: ZodType<T>) {}
  transform(value: unknown, _meta: ArgumentMetadata): T {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw Errors.validation(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return result.data;
  }
}

export const UuidPipe = new (class implements PipeTransform<string, string> {
  transform(value: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw Errors.notFound();
    return value;
  }
})();

/** A positive whole-number id in a path (audit event ids are bigint identities); anything else is a 404. */
export const IdNumberPipe = new (class implements PipeTransform<string, string> {
  transform(value: string) {
    if (!/^[1-9][0-9]{0,17}$/.test(value)) throw Errors.notFound();
    return value;
  }
})();
