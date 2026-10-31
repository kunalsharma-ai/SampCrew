import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const listQuery = z.object({ unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

/** In-app notifications for the signed-in member. Everyone sees only their own. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @Doc({ summary: 'Your notifications, newest first', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => ({
      unread: (await one<{ n: number }>(tx, 'select count(*)::int as n from notifications where membership_id = $1 and read_at is null', [me]))!.n,
      items: await many(
        tx,
        `select id, kind, title, body, link, read_at as "readAt", created_at as "createdAt" from notifications
          where membership_id = $1 ${q.unread === 'true' ? 'and read_at is null' : ''} order by created_at desc limit $2`,
        [me, q.limit],
      ),
    }));
  }

  @Get('unread-count')
  @Doc({ summary: 'Number of unread notifications' })
  count() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => (await one<{ unread: number }>(tx, 'select count(*)::int as unread from notifications where membership_id = $1 and read_at is null', [me]))!);
  }

  @Post(':id/read')
  @HttpCode(204)
  @Doc({ summary: 'Mark one notification read' })
  async read(@Param('id', UuidPipe) id: string) {
    const me = requestContext.tenantActor().membershipId;
    const r = await this.db.tenant((tx) => tx.query('update notifications set read_at = coalesce(read_at, now()) where id = $1 and membership_id = $2', [id, me]));
    if (!r.rowCount) throw Errors.notFound('Notification');
  }

  @Post('read-all')
  @HttpCode(204)
  @Doc({ summary: 'Mark all your notifications read' })
  async readAll() {
    const me = requestContext.tenantActor().membershipId;
    await this.db.tenant((tx) => tx.query('update notifications set read_at = now() where membership_id = $1 and read_at is null', [me]));
  }
}
