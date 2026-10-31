import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { z, type ZodType } from 'zod';
import { FEATURE_KEY, PERMISSION_KEY, PUBLIC_KEY, REALM_KEY, ROOT_PATH_KEY } from '../authz/decorators';

interface DocMeta {
  summary: string;
  description?: string;
  body?: ZodType;
  query?: ZodType;
}

const DOC_KEY = 'crew:doc';

/** Documents a route for the generated OpenAPI 3.1 spec, reusing the same zod schemas that validate it. */
export const Doc = (meta: DocMeta): MethodDecorator => (target, key, descriptor) => {
  Reflect.defineMetadata(DOC_KEY, meta, descriptor.value as object);
  return descriptor;
};

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

const toSchema = (s: ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

/** Builds an OpenAPI document from controller classes. */
export function buildOpenApi(controllers: (new (...args: never[]) => unknown)[], globalPrefix = 'api/v1') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ctrl of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, ctrl) as string) ?? '';
    const tag = ctrl.name.replace(/Controller$/, '');
    const classPublic = Reflect.getMetadata(PUBLIC_KEY, ctrl) === true;
    const classRealm = Reflect.getMetadata(REALM_KEY, ctrl) as { realm: string } | undefined;
    const prefix = Reflect.getMetadata(ROOT_PATH_KEY, ctrl) === true ? '' : globalPrefix;
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = (ctrl.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (method === undefined) continue;
      const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
      const full = '/' + [prefix, base, sub].map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/');
      const oaPath = full.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const doc = Reflect.getMetadata(DOC_KEY, handler) as DocMeta | undefined;
      const permission = Reflect.getMetadata(PERMISSION_KEY, handler) as string | undefined;
      const feature = (Reflect.getMetadata(FEATURE_KEY, handler) ?? Reflect.getMetadata(FEATURE_KEY, ctrl)) as string | undefined;
      const isPublic = classPublic || Reflect.getMetadata(PUBLIC_KEY, handler) === true;
      const realm = (Reflect.getMetadata(REALM_KEY, handler) as { realm: string } | undefined) ?? classRealm;
      const params = [...full.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      if (doc?.query) {
        const qs = toSchema(doc.query) as { properties?: Record<string, unknown>; required?: string[] };
        for (const [qn, schema] of Object.entries(qs.properties ?? {})) params.push({ name: qn, in: 'query', required: (qs.required ?? []).includes(qn), schema } as never);
      }
      const notes = [
        permission ? `Requires permission \`${permission}\`.` : null,
        feature ? `Requires plan feature \`${feature}\`.` : null,
        realm?.realm === 'platform' ? 'SAMPLEDGE platform realm (console token, MFA required).' : null,
      ].filter(Boolean);
      paths[oaPath] ??= {};
      paths[oaPath]![METHODS[method] ?? 'get'] = {
        tags: [realm?.realm === 'platform' ? `Platform: ${tag.replace(/^Platform/, '')}` : tag],
        summary: doc?.summary ?? name,
        description: [doc?.description, ...notes].filter(Boolean).join('\n\n') || undefined,
        operationId: `${tag}_${name}`,
        security: isPublic ? [] : [{ [realm?.realm === 'platform' ? 'platformBearer' : 'bearer']: [] }],
        parameters: params.length ? params : undefined,
        requestBody: doc?.body ? { required: true, content: { 'application/json': { schema: toSchema(doc.body) } } } : undefined,
        responses: {
          '200': { description: 'Success' },
          '4XX': { description: 'Error envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'CREW API',
      version: '1.0.0',
      description:
        'CREW by SAMPLEDGE REST API. All tenant routes are scoped to the tenant in the bearer token and protected by PostgreSQL Row-Level Security. ' +
        'Send `Idempotency-Key` on POST requests you may retry. Lists use cursor pagination (`limit`, `cursor`).',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        platformBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'SAMPLEDGE Super Admin Console token' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: {} }, required: ['code', 'message'] } },
        },
      },
    },
    paths,
  };
}
