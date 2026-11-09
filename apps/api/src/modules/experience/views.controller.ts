import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { MAX_VIEWS_PER_PAGE, VIEW_PAGES, savedViewInput, savedViewPatch } from '@crew/contracts';
import { z } from 'zod';
import { requestContext } from '../../platform/context/request-context';
import { ieq, MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const listQuery = z.object({ page: z.enum(VIEW_PAGES) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const view = (v: Record<string, any> | undefined) => v && { id: v.id, page: v.page, name: v.name, state: v.state, isDefault: v.is_default, updatedAt: v.updated_at };

/**
 * Saved table views: a member's named combinations of filters, sort, columns and density for a list page.
 * Views only remember how a list is shown; the list itself still applies the member's permissions.
 */
@Controller('me/views')
export class ViewsController {
  constructor(private readonly db: DatabaseService) {}

  private async clearDefault(tx: Tx, page: string, except: string | null) {
    const me = requestContext.tenantActor().membershipId;
    await tx.collection('saved_views').update({ membership_id: me, page, is_default: true, ...(except ? { id: { $ne: except } } : {}) }, { $set: { is_default: false } });
  }

  @Get()
  @Doc({ summary: 'Your saved views for a list page', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => (await tx.collection('saved_views').find({ membership_id: me, page: q.page }))
      .sort((a, b) => Number(b.is_default) - Number(a.is_default) || String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()))
      .map((v) => view(v)!));
  }

  @Post()
  @Doc({ summary: 'Save the current filters, sort, columns and density as a named view', body: savedViewInput })
  create(@Body(new ZodPipe(savedViewInput)) body: z.infer<typeof savedViewInput>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const n = await tx.collection('saved_views').count({ membership_id: me, page: body.page });
      if (n >= MAX_VIEWS_PER_PAGE) throw Errors.conflict('too_many_views', `You can keep up to ${MAX_VIEWS_PER_PAGE} views per list. Delete one first.`);
      if (await tx.collection('saved_views').exists({ membership_id: me, page: body.page, name: ieq(body.name) })) {
        throw Errors.conflict('view_name_taken', 'You already have a view with that name');
      }
      if (body.isDefault) await this.clearDefault(tx, body.page, null);
      return view(await tx.collection('saved_views').insert({ membership_id: me, page: body.page, name: body.name, state: body.state, is_default: body.isDefault }));
    });
  }

  @Patch(':id')
  @Doc({ summary: 'Rename a view, replace what it remembers, or make it your default', body: savedViewPatch })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(savedViewPatch)) body: z.infer<typeof savedViewPatch>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const cur = await tx.collection('saved_views').findOne({ id, membership_id: me });
      if (!cur) throw Errors.notFound('View');
      if (body.name && (await tx.collection('saved_views').exists({ membership_id: me, page: cur.page, name: ieq(body.name), id: { $ne: id } }))) {
        throw Errors.conflict('view_name_taken', 'You already have a view with that name');
      }
      if (body.isDefault) await this.clearDefault(tx, cur.page, id);
      const set = { ...(body.name != null ? { name: body.name } : {}), ...(body.state != null ? { state: body.state } : {}), ...(body.isDefault != null ? { is_default: body.isDefault } : {}) };
      return view(Object.keys(set).length ? await tx.collection('saved_views').updateAndGet({ id, membership_id: me }, { $set: set }) : cur);
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @Doc({ summary: 'Delete one of your views' })
  async remove(@Param('id', UuidPipe) id: string) {
    const me = requestContext.tenantActor().membershipId;
    const n = await this.db.tenant((tx) => tx.collection('saved_views').delete({ id, membership_id: me }));
    if (!n) throw Errors.notFound('View');
  }
}
