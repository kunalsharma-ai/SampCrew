import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { mobileAppDraftInput, mobileAppPreviewQuery, mobileAppPublishInput, type MobileAppPublishInput } from '@crew/contracts';
import { z } from 'zod';
import { AllowWithoutMfa, RequirePermission } from '../../platform/authz/decorators';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { MobileAppService } from './mobile-app.service';

const mineQuery = z.object({ since: z.coerce.number().int().min(0).optional() });
const restoreInput = z.object({ note: z.string().trim().max(300).default('') });

/** The app each phone shows: modules, menu, quick actions and widgets for the signed-in person. */
@Controller('mobile/app')
export class MobileAppController {
  constructor(private readonly app: MobileAppService) {}

  @Get()
  @AllowWithoutMfa()
  @Doc({
    summary: 'The mobile app for me: the modules, menu, quick actions and home widgets the Super Workspace published for my level, limited by my own access',
    description: 'Pass `since` (the version the phone has) to learn cheaply whether anything changed (`unchanged: true`).',
    query: mineQuery,
  })
  mine(@Query(new ZodPipe(mineQuery)) q: z.infer<typeof mineQuery>) {
    return this.app.mine(q.since);
  }
}

/** Super Workspace > Settings > Mobile app: draft, preview, publish, history and restore. */
@Controller('mobile-app')
export class MobileAppAdminController {
  constructor(private readonly app: MobileAppService) {}

  @Get()
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'Mobile app configuration: published version, draft with its checks and changes, module counts and recent phone use' })
  overview() {
    return this.app.overview();
  }

  @Put('draft')
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'Save the draft configuration (phones keep the published one until you publish)', body: mobileAppDraftInput })
  saveDraft(@Body(new ZodPipe(mobileAppDraftInput)) body: z.infer<typeof mobileAppDraftInput>) {
    return this.app.saveDraft(body.config);
  }

  @Post('draft/discard')
  @HttpCode(200)
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'Throw the draft away and go back to the published configuration' })
  discard() {
    return this.app.discardDraft();
  }

  @Post('publish')
  @HttpCode(200)
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'Publish the draft as a new version: every phone follows it within a minute. Refused if the checks fail, or (until confirmed) if it hides modules people use.', body: mobileAppPublishInput })
  publish(@Body(new ZodPipe(mobileAppPublishInput)) body: MobileAppPublishInput) {
    return this.app.publish(body);
  }

  @Get('versions')
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'Every published version: number, when, who, note and what changed' })
  versions() {
    return this.app.versions();
  }

  @Get('versions/:version')
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'One published version with its full configuration' })
  version(@Param('version', ParseIntPipe) version: number) {
    return this.app.version(version);
  }

  @Post('versions/:version/restore')
  @HttpCode(200)
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'Publish an old version again (as a new version; the history keeps both)', body: restoreInput })
  restore(@Param('version', ParseIntPipe) version: number, @Body(new ZodPipe(restoreInput)) body: z.infer<typeof restoreInput>) {
    return this.app.restore(version, body.note);
  }

  @Get('preview')
  @RequirePermission('mobileapp:manage')
  @Doc({ summary: 'Read-only preview of the app for a level (draft or published), with the company modules and no individual permissions', query: mobileAppPreviewQuery })
  preview(@Query(new ZodPipe(mobileAppPreviewQuery)) q: z.infer<typeof mobileAppPreviewQuery>) {
    return this.app.preview(q.level, q.source);
  }
}
