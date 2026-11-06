import { type ArgumentsHost, Body, Catch, Controller, Delete, type ExceptionFilter, Get, HttpCode, HttpException, Param, Post, Put, Patch, Query, Req, UseFilters } from '@nestjs/common';
import {
  SCIM_ERROR_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA, scimGroupInput, type ScimGroupInput, scimPatchInput, type ScimPatchInput, scimUserInput,
  type ScimUserInput,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ScimRealm } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { ScimGroupsService } from './scim-groups.service';
import { ScimError, ScimService } from './scim.service';

const listQuery = z.object({
  filter: z.string().max(500).optional(),
  startIndex: z.coerce.number().int().min(1).optional(),
  count: z.coerce.number().int().min(0).optional(),
  excludedAttributes: z.string().max(200).optional(),
});

/** Renders errors in the SCIM format (RFC 7644 section 3.12) and logs failed calls for the provisioning log. */
@Catch()
class ScimExceptionFilter implements ExceptionFilter {
  constructor(private readonly scim: ScimService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = 500;
    let detail = 'Something went wrong';
    let scimType: string | undefined;
    if (exception instanceof ScimError) {
      status = exception.getStatus();
      detail = exception.message;
      scimType = exception.scimType;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as { message?: unknown; details?: unknown };
      detail = typeof body === 'object' && body ? String(body.message ?? exception.message) : String(body);
      if (status === 422) {
        status = 400;
        scimType = 'invalidValue';
        if (body.details) detail = `${detail}: ${JSON.stringify(body.details).slice(0, 300)}`;
      }
    } else if ((exception as { code?: string })?.code === '23505') {
      status = 409;
      scimType = 'uniqueness';
      detail = 'A resource with these details already exists';
    }
    if (requestContext.get()?.actor?.kind === 'user' && status !== 401) await this.scim.logFailure(req.method, req.path.replace(/^\/api\/v1\/scim\/v2/, ''), status, detail);
    res.status(status).type('application/scim+json').send(JSON.stringify({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail }));
  }
}

/**
 * SCIM 2.0 endpoints for identity providers. Base URL: <API>/api/v1/scim/v2. Authenticate with
 * "Authorization: Bearer scim_…" (create the token in Settings, Single sign-on and provisioning).
 */
@Controller('scim/v2')
@ScimRealm()
@UseFilters(ScimExceptionFilter)
export class ScimController {
  constructor(
    private readonly scim: ScimService,
    private readonly groups: ScimGroupsService,
  ) {}

  private base(req: Request) {
    return `${req.protocol}://${req.get('host')}/api/v1/scim/v2`;
  }


  @Get('ServiceProviderConfig')
  @Doc({ summary: 'SCIM: what this server supports' })
  config() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A SCIM token created by a workspace owner in SampCrew' }],
    };
  }

  @Get('ResourceTypes')
  @Doc({ summary: 'SCIM: resource types (Users and Groups)' })
  resourceTypes() {
    const t = (id: string, schema: string) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id, name: id, endpoint: `/${id}s`, schema });
    return { schemas: [SCIM_LIST_SCHEMA], totalResults: 2, Resources: [t('User', SCIM_USER_SCHEMA), t('Group', SCIM_GROUP_SCHEMA)] };
  }

  @Get('Users')
  @Doc({ summary: 'SCIM: list users, filtered by userName eq or externalId eq', query: listQuery })
  async list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>, @Req() req: Request) {
    return this.scim.list(q, this.base(req));
  }

  @Get('Users/:id')
  @Doc({ summary: 'SCIM: a user' })
  get(@Param('id') id: string, @Req() req: Request) {
    return this.scim.get(id, this.base(req));
  }

  @Post('Users')
  @Doc({ summary: 'SCIM: create a user (a workspace member with the Employee role who signs in with single sign-on)', body: scimUserInput })
  async create(@Body(new ZodPipe(scimUserInput)) body: ScimUserInput, @Req() req: Request) {
    const r = await this.scim.create(body, this.base(req));
    req.res!.status(201).type('application/scim+json');
    return r;
  }

  @Put('Users/:id')
  @Doc({ summary: 'SCIM: replace a user (name, active, externalId)', body: scimUserInput })
  replace(@Param('id') id: string, @Body(new ZodPipe(scimUserInput)) body: ScimUserInput, @Req() req: Request) {
    return this.scim.replace(id, body, this.base(req));
  }

  @Patch('Users/:id')
  @Doc({ summary: 'SCIM: update a user (active, name, externalId)', body: scimPatchInput })
  patch(@Param('id') id: string, @Body(new ZodPipe(scimPatchInput)) body: ScimPatchInput, @Req() req: Request) {
    return this.scim.patch(id, body, this.base(req));
  }

  @Delete('Users/:id')
  @HttpCode(204)
  @Doc({ summary: 'SCIM: deactivate a user (history is kept)' })
  async remove(@Param('id') id: string) {
    await this.scim.remove(id);
  }

  @Get('Groups')
  @Doc({ summary: 'SCIM: list groups, filtered by displayName eq or externalId eq', query: listQuery })
  listGroups(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>, @Req() req: Request) {
    return this.groups.list(q, this.base(req));
  }

  @Get('Groups/:id')
  @Doc({ summary: 'SCIM: a group and its members' })
  getGroup(@Param('id') id: string, @Req() req: Request) {
    return this.groups.get(id, this.base(req));
  }

  @Post('Groups')
  @Doc({ summary: 'SCIM: create a group. It grants no role until a workspace owner maps it to one in SampCrew.', body: scimGroupInput })
  async createGroup(@Body(new ZodPipe(scimGroupInput)) body: ScimGroupInput, @Req() req: Request) {
    const r = await this.groups.create(body, this.base(req));
    req.res!.status(201).type('application/scim+json');
    return r;
  }

  @Put('Groups/:id')
  @Doc({ summary: 'SCIM: replace a group (name and the full member list)', body: scimGroupInput })
  replaceGroup(@Param('id') id: string, @Body(new ZodPipe(scimGroupInput)) body: ScimGroupInput, @Req() req: Request) {
    return this.groups.replace(id, body, this.base(req));
  }

  @Patch('Groups/:id')
  @Doc({ summary: 'SCIM: add or remove members, or rename a group', body: scimPatchInput })
  patchGroup(@Param('id') id: string, @Body(new ZodPipe(scimPatchInput)) body: ScimPatchInput, @Req() req: Request) {
    return this.groups.patch(id, body, this.base(req));
  }

  @Delete('Groups/:id')
  @HttpCode(204)
  @Doc({ summary: 'SCIM: delete a group; roles it granted are removed from its members' })
  async removeGroup(@Param('id') id: string) {
    await this.groups.remove(id);
  }
}
