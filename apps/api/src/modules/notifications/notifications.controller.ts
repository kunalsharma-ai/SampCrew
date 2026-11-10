import { AllowWhenLocked } from '../../platform/authz/decorators';
import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const listQuery = z.object({ unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

/** In-app notifications for the signed-in member. Everyone sees only their own. */
@Controller('notifications')
@AllowWhenLocked()
export class NotificationsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @Doc({ summary: 'Your notifications, newest first', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      const notes = tx.collection('notifications');
      const items = await notes.find({ membership_id: me, ...(q.unread === 'true' ? { read_at: null } : {}) }, { sort: { created_at: -1 }, limit: q.limit });
      return {
        unread: await notes.count({ membership_id: me, read_at: null }),
        items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, readAt: n.read_at ?? null, createdAt: n.created_at })),
      };
    });
  }

  @Get('unread-count')
  @Doc({ summary: 'Number of unread notifications' })
  count() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => ({ unread: await tx.collection('notifications').count({ membership_id: me, read_at: null }) }));
  }

  @Post(':id/read')
  @HttpCode(204)
  @Doc({ summary: 'Mark one notification read' })
  async read(@Param('id', UuidPipe) id: string) {
    const me = requestContext.tenantActor().membershipId;
    const found = await this.db.tenant(async (tx) => {
      const notes = tx.collection('notifications');
      if (!(await notes.exists({ id, membership_id: me }))) return false;
      await notes.updateOne({ id, read_at: null }, { $set: { read_at: new Date() } });
      return true;
    });
    if (!found) throw Errors.notFound('Notification');
  }

  @Post('read-all')
  @HttpCode(204)
  @Doc({ summary: 'Mark all your notifications read' })
  async readAll() {
    const me = requestContext.tenantActor().membershipId;
    await this.db.tenant((tx) => tx.collection('notifications').update({ membership_id: me, read_at: null }, { $set: { read_at: new Date() } }));
  }
}
