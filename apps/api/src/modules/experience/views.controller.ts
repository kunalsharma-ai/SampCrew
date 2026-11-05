import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { MAX_VIEWS_PER_PAGE, VIEW_PAGES, savedViewInput, savedViewPatch } from '@crew/contracts';
import { z } from 'zod';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const listQuery = z.object({ page: z.enum(VIEW_PAGES) });
const COLS = `id, page, name, state, is_default as "isDefault", updated_at as "updatedAt"`;

/**
 * Saved table views: a member's named combinations of filters, sort, columns and density for a list page.
 * Views only remember how a list is shown; the list itself still applies the member's permissions.
 */
@Controller('me/views')
export class ViewsController {
  constructor(private readonly db: DatabaseService) {}

  private async clearDefault(tx: Tx, page: string, except: string | null) {
    const me = requestContext.tenantActor().membershipId;
    await tx.query(`update saved_views set is_default = false where membership_id = $1 and page = $2 and is_default and id is distinct from $3`, [me, page, except]);
  }

  @Get()
  @Doc({ summary: 'Your saved views for a list page', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant((tx) => many(tx, `select ${COLS} from saved_views where membership_id = $1 and page = $2 order by is_default desc, lower(name)`, [me, q.page]));
  }

  @Post()
  @Doc({ summary: 'Save the current filters, sort, columns and density as a named view', body: savedViewInput })
  create(@Body(new ZodPipe(savedViewInput)) body: z.infer<typeof savedViewInput>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const n = (await one<{ n: number }>(tx, 'select count(*)::int as n from saved_views where membership_id = $1 and page = $2', [me, body.page]))!.n;
      if (n >= MAX_VIEWS_PER_PAGE) throw Errors.conflict('too_many_views', `You can keep up to ${MAX_VIEWS_PER_PAGE} views per list. Delete one first.`);
      if (await one(tx, 'select 1 from saved_views where membership_id = $1 and page = $2 and lower(name) = lower($3)', [me, body.page, body.name])) {
        throw Errors.conflict('view_name_taken', 'You already have a view with that name');
      }
      if (body.isDefault) await this.clearDefault(tx, body.page, null);
      return one(tx, `insert into saved_views (tenant_id, membership_id, page, name, state, is_default) values (app_tenant_id(), $1, $2, $3, $4, $5) returning ${COLS}`, [me, body.page, body.name, body.state, body.isDefault]);
    });
  }

  @Patch(':id')
  @Doc({ summary: 'Rename a view, replace what it remembers, or make it your default', body: savedViewPatch })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(savedViewPatch)) body: z.infer<typeof savedViewPatch>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const cur = await one<{ page: string }>(tx, 'select page from saved_views where id = $1 and membership_id = $2', [id, me]);
      if (!cur) throw Errors.notFound('View');
      if (body.name && (await one(tx, 'select 1 from saved_views where membership_id = $1 and page = $2 and lower(name) = lower($3) and id <> $4', [me, cur.page, body.name, id]))) {
        throw Errors.conflict('view_name_taken', 'You already have a view with that name');
      }
      if (body.isDefault) await this.clearDefault(tx, cur.page, id);
      return one(
        tx,
        `update saved_views set name = coalesce($3, name), state = coalesce($4, state), is_default = coalesce($5, is_default) where id = $1 and membership_id = $2 returning ${COLS}`,
        [id, me, body.name ?? null, body.state ?? null, body.isDefault ?? null],
      );
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @Doc({ summary: 'Delete one of your views' })
  async remove(@Param('id', UuidPipe) id: string) {
    const me = requestContext.tenantActor().membershipId;
    const r = await this.db.tenant((tx) => tx.query('delete from saved_views where id = $1 and membership_id = $2', [id, me]));
    if (!r.rowCount) throw Errors.notFound('View');
  }
}
