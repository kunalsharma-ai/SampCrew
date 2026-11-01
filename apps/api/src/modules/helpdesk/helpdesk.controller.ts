import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  announcementInput,
  type AnnouncementInput,
  articleInput,
  type ArticleInput,
  CASE_STATUSES,
  caseAssignInput,
  caseCategoryInput,
  caseInput,
  type CaseInput,
  caseMessageInput,
  casePriorityInput,
  caseStatusInput,
  categoryInput,
  type CategoryInput,
  satisfactionInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AnnouncementsService } from './announcements.service';
import { HelpdeskService } from './helpdesk.service';

const caseQuery = z.object({
  view: z.enum(['mine', 'queue']).default('mine'),
  status: z.enum(['active', ...CASE_STATUSES]).optional(),
  assigned: z.enum(['me', 'unassigned', 'all']).optional(),
  q: z.string().trim().max(80).optional(),
});
const articleQuery = z.object({ categoryId: z.uuid().optional(), q: z.string().trim().max(80).optional(), all: z.enum(['true', 'false']).optional() });
const categoryQuery = z.object({ manage: z.enum(['true', 'false']).optional() });

@Controller('helpdesk')
@RequireFeature('self_service')
export class HelpdeskController {
  constructor(private readonly helpdesk: HelpdeskService) {}

  @Get('summary')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Counts of my open cases and of cases assigned to me' })
  summary() {
    return this.helpdesk.summary();
  }

  @Get('categories')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Helpdesk categories with response targets; with manage=true, also archived ones and their handlers (helpdesk:configure)', query: categoryQuery })
  categories(@Query(new ZodPipe(categoryQuery)) q: z.infer<typeof categoryQuery>) {
    return this.helpdesk.categories(q.manage === 'true');
  }

  @Post('categories')
  @RequirePermission('helpdesk:configure')
  @Doc({ summary: 'Add a category with response targets and handlers', body: categoryInput })
  createCategory(@Body(new ZodPipe(categoryInput)) body: CategoryInput) {
    return this.helpdesk.createCategory(body);
  }

  @Put('categories/:id')
  @RequirePermission('helpdesk:configure')
  @Doc({ summary: 'Change a category. Existing cases keep the confidentiality they were raised with.', body: categoryInput })
  updateCategory(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(categoryInput)) body: CategoryInput) {
    return this.helpdesk.updateCategory(id, body);
  }

  @Post('categories/:id/archive')
  @HttpCode(200)
  @RequirePermission('helpdesk:configure')
  @Doc({ summary: 'Stop offering a category for new cases' })
  archiveCategory(@Param('id', UuidPipe) id: string) {
    return this.helpdesk.archiveCategory(id);
  }

  @Get('handlers')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Members who can handle cases (helpdesk:manage or helpdesk:configure needed)' })
  handlers() {
    return this.helpdesk.handlers();
  }

  @Get('articles')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Published help articles, optionally by category or search; all=true includes drafts (helpdesk:configure)', query: articleQuery })
  articles(@Query(new ZodPipe(articleQuery)) q: z.infer<typeof articleQuery>) {
    return this.helpdesk.articles({ ...q, all: q.all === 'true' });
  }

  @Get('articles/:id')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'One help article' })
  article(@Param('id', UuidPipe) id: string) {
    return this.helpdesk.article(id);
  }

  @Post('articles')
  @RequirePermission('helpdesk:configure')
  @Doc({ summary: 'Write a help article', body: articleInput })
  createArticle(@Body(new ZodPipe(articleInput)) body: ArticleInput) {
    return this.helpdesk.saveArticle(null, body);
  }

  @Put('articles/:id')
  @RequirePermission('helpdesk:configure')
  @Doc({ summary: 'Change a help article', body: articleInput })
  updateArticle(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(articleInput)) body: ArticleInput) {
    return this.helpdesk.saveArticle(id, body);
  }

  @Delete('articles/:id')
  @HttpCode(204)
  @RequirePermission('helpdesk:configure')
  @Doc({ summary: 'Delete a help article' })
  async removeArticle(@Param('id', UuidPipe) id: string) {
    await this.helpdesk.removeArticle(id);
  }

  @Get('cases')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'My cases, or the queue of cases I can handle (helpdesk:manage), most urgent first', query: caseQuery })
  cases(@Query(new ZodPipe(caseQuery)) q: z.infer<typeof caseQuery>) {
    return this.helpdesk.list(q);
  }

  @Post('cases')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Raise a case; handlers can log one for someone in their scope with employeeId', body: caseInput })
  create(@Body(new ZodPipe(caseInput)) body: CaseInput) {
    return this.helpdesk.create(body);
  }

  @Get('cases/:id')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'A case with its conversation; handlers also get internal notes and history' })
  get(@Param('id', UuidPipe) id: string) {
    return this.helpdesk.get(id);
  }

  @Post('cases/:id/messages')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Reply on a case; handlers can add internal notes', body: caseMessageInput })
  reply(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(caseMessageInput)) body: z.infer<typeof caseMessageInput>) {
    return this.helpdesk.reply(id, body.body, body.internal, body.aiInteractionId);
  }

  @Post('cases/:id/status')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Move a case: handlers work and resolve it; the person confirms (closes) or reopens it', body: caseStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(caseStatusInput)) body: z.infer<typeof caseStatusInput>) {
    return this.helpdesk.setStatus(id, body.status, body.message);
  }

  @Put('cases/:id/assignee')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Assign or unassign a case', body: caseAssignInput })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(caseAssignInput)) body: z.infer<typeof caseAssignInput>) {
    return this.helpdesk.assign(id, body.assigneeMembershipId);
  }

  @Put('cases/:id/priority')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Change priority; response targets are recalculated', body: casePriorityInput })
  priority(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(casePriorityInput)) body: z.infer<typeof casePriorityInput>) {
    return this.helpdesk.setPriority(id, body.priority);
  }

  @Put('cases/:id/category')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Move a case to another category; moving into a confidential one makes it confidential', body: caseCategoryInput })
  category(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(caseCategoryInput)) body: z.infer<typeof caseCategoryInput>) {
    return this.helpdesk.setCategory(id, body.categoryId);
  }

  @Post('cases/:id/rating')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Rate how a resolved case was handled (once)', body: satisfactionInput })
  rate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(satisfactionInput)) body: z.infer<typeof satisfactionInput>) {
    return this.helpdesk.rate(id, body.rating, body.comment);
  }
}

@Controller('announcements')
@RequireFeature('self_service')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @RequirePermission('announcements:read')
  @Doc({ summary: 'Announcements addressed to me, pinned first' })
  feed() {
    return this.announcements.feed();
  }

  @Get('manage')
  @RequirePermission('announcements:manage')
  @Doc({ summary: 'All announcements with audience size, reads and acknowledgements' })
  list() {
    return this.announcements.list();
  }

  @Get('manage/:id')
  @RequirePermission('announcements:manage')
  @Doc({ summary: 'One announcement with who has read and acknowledged it' })
  detail(@Param('id', UuidPipe) id: string) {
    return this.announcements.detail(id);
  }

  @Get(':id')
  @RequirePermission('announcements:read')
  @Doc({ summary: 'Open an announcement; records the first read' })
  read(@Param('id', UuidPipe) id: string) {
    return this.announcements.read(id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @RequirePermission('announcements:read')
  @Doc({ summary: 'Acknowledge an announcement that asks for it' })
  acknowledge(@Param('id', UuidPipe) id: string) {
    return this.announcements.acknowledge(id);
  }

  @Post()
  @RequirePermission('announcements:manage')
  @Doc({ summary: 'Draft an announcement', body: announcementInput })
  create(@Body(new ZodPipe(announcementInput)) body: AnnouncementInput) {
    return this.announcements.save(null, body);
  }

  @Put(':id')
  @RequirePermission('announcements:manage')
  @Doc({ summary: 'Change a draft; after publishing only pinning and expiry can change', body: announcementInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(announcementInput)) body: AnnouncementInput) {
    return this.announcements.save(id, body);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermission('announcements:manage')
  @Doc({ summary: 'Publish a draft and notify its audience' })
  publish(@Param('id', UuidPipe) id: string) {
    return this.announcements.publish(id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('announcements:manage')
  @Doc({ summary: 'Take a published announcement off the feed' })
  archive(@Param('id', UuidPipe) id: string) {
    return this.announcements.archive(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('announcements:manage')
  @Doc({ summary: 'Delete a draft' })
  async remove(@Param('id', UuidPipe) id: string) {
    await this.announcements.remove(id);
  }
}
