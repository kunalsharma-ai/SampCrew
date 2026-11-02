import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { privacyDecisionInput, privacyRequestInput, retentionPolicyInput, type RetentionPolicyInput } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { PrivacyService } from './privacy.service';

const listQuery = z.object({ status: z.enum(['open', 'completed', 'rejected']).optional() });

/** Privacy requests (access and erasure). Available on every plan: answering them is a legal duty. */
@Controller('privacy/requests')
@RequirePermission('privacy:manage')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get()
  @Doc({ summary: 'Privacy requests, open ones first by due date', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.privacy.list(q.status);
  }

  @Post()
  @Doc({ summary: 'Log a request from a person for a copy of their data (access) or to erase it. Due in 30 days.', body: privacyRequestInput })
  create(@Body(new ZodPipe(privacyRequestInput)) body: z.infer<typeof privacyRequestInput>) {
    return this.privacy.create(body);
  }

  @Get(':id')
  @Doc({ summary: 'A privacy request, with what erasure removes and keeps' })
  get(@Param('id', UuidPipe) id: string) {
    return this.privacy.get(id);
  }

  @Post(':id/export')
  @HttpCode(200)
  @Doc({ summary: 'Prepare the person\'s data export (JSON) and complete an access request', body: privacyDecisionInput })
  fulfil(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(privacyDecisionInput)) body: z.infer<typeof privacyDecisionInput>) {
    return this.privacy.fulfilAccess(id, body.note);
  }

  @Get(':id/export')
  @Doc({ summary: 'Download the export (audited)' })
  async download(@Param('id', UuidPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.privacy.download(id);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${f.fileName}"`);
    res.setHeader('cache-control', 'no-store');
    return new StreamableFile(f.stream, { length: f.size });
  }

  @Post(':id/erase')
  @HttpCode(200)
  @Doc({ summary: 'Erase the person\'s details (only after they have left) and complete an erasure request. Cannot be undone.', body: privacyDecisionInput })
  erase(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(privacyDecisionInput)) body: z.infer<typeof privacyDecisionInput>) {
    return this.privacy.erase(id, body.note);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Doc({ summary: 'Close a request without acting, with the reason (for example a legal hold)', body: privacyDecisionInput })
  reject(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(privacyDecisionInput)) body: z.infer<typeof privacyDecisionInput>) {
    return this.privacy.reject(id, body.note);
  }
}

/** The workspace's retention schedule: when leavers are erased automatically, and when exports and logs are deleted. */
@Controller('privacy/retention')
@RequirePermission('privacy:manage')
export class RetentionController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get()
  @Doc({ summary: 'The retention schedule (defaults until someone saves one), how many leavers are due for erasure, and recent runs' })
  get() {
    return this.privacy.retention();
  }

  @Put()
  @Doc({ summary: 'Change the retention schedule. Automatic erasure of leavers is off unless a number of years is set.', body: retentionPolicyInput })
  set(@Body(new ZodPipe(retentionPolicyInput)) body: RetentionPolicyInput) {
    return this.privacy.setRetention(body);
  }

  @Post('run')
  @HttpCode(200)
  @Doc({ summary: 'Apply the retention schedule now (it also runs once a day on its own)' })
  run() {
    return this.privacy.applyRetention(requestContext.tenantActor().tenantId, 'manual');
  }
}
