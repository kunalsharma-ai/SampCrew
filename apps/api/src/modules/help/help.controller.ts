import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  COMM_FILE_MAX_BYTES,
  helpArticleInput,
  helpAssignInput,
  helpCategoryInput,
  helpEscalateInput,
  helpFeedbackInput,
  helpProgressInput,
  helpQueryCategoryInput,
  helpQueryInput,
  helpQueryListQuery,
  helpRateInput,
  helpReplyInput,
  helpSearchQuery,
  helpSettingsInput,
  helpStatusInput,
  type HelpArticleInput,
  type HelpCategoryInput,
  type HelpQueryCategoryInput,
  type HelpQueryInput,
  type HelpQueryListQuery,
  type HelpReplyInput,
  type HelpSearchQuery,
  type HelpSettings,
} from '@crew/contracts';
import { z } from 'zod';
import { AllowWhenLocked, PlatformRealm, Public } from '../../platform/authz/decorators';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { HelpContentService } from './help-content.service';
import { HelpQueriesService } from './help-queries.service';

const slugParam = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80);
const statusOnly = z.object({ status: z.enum(['published', 'draft']) });
const adminAssign = z.object({ assigneeId: z.uuid().nullable() });

/**
 * Help & Support for workspace members: the help centre filtered for the person, Raise a Query and the queries
 * inbox. Every plan has it (the foundation). The three feature parts close these routes when a level switched them off
 * (core_hr.help_centre for /help, core_hr.help_queries for /help/queries and /help/files, core_hr.help_inbox for
 * /help/inbox), and the service checks who may see each query. It keeps working while a workspace is read-only, since
 * that is when people most need help.
 */
@Controller('help')
@AllowWhenLocked()
export class HelpController {
  constructor(
    private readonly content: HelpContentService,
    private readonly queries: HelpQueriesService,
    private readonly db: DatabaseService,
  ) {}

  @Get()
  @Doc({ summary: 'The help centre for you: categories, quick starts, recommended guides, FAQs, popular and recently viewed articles, and your queries' })
  async home() {
    const home = await this.content.home();
    const queries = await this.db.tenant((tx) => this.queries.summaryIn(tx));
    return { ...home, queries };
  }

  @Get('search')
  @Doc({ summary: 'Search the help articles you can see: feature and module names, questions, error messages and instructions', query: helpSearchQuery })
  search(@Query(new ZodPipe(helpSearchQuery)) q: HelpSearchQuery) {
    return this.content.search(q);
  }

  @Get('categories/:key')
  @Doc({ summary: 'One help category with its subcategories and articles (only what you can see)' })
  category(@Param('key', new ZodPipe(slugParam)) key: string) {
    return this.content.category(key);
  }

  @Get('articles/:slug')
  @Doc({ summary: 'One help article (counted as viewed by you), with related articles, its helpful votes and your tutorial progress' })
  article(@Param('slug', new ZodPipe(slugParam)) slug: string) {
    return this.content.article(slug);
  }

  @Put('articles/:slug/feedback')
  @Doc({ summary: 'Was this article helpful? (your answer, changeable)', body: helpFeedbackInput })
  feedback(@Param('slug', new ZodPipe(slugParam)) slug: string, @Body(new ZodPipe(helpFeedbackInput)) body: z.infer<typeof helpFeedbackInput>) {
    return this.content.feedback(slug, body.helpful);
  }

  @Put('articles/:slug/progress')
  @Doc({ summary: 'Mark a step of a guide or tutorial done (or not done); progress is saved for you', body: helpProgressInput })
  progress(@Param('slug', new ZodPipe(slugParam)) slug: string, @Body(new ZodPipe(helpProgressInput)) body: z.infer<typeof helpProgressInput>) {
    return this.content.progress(slug, body.step, body.done);
  }

  // Raise a Query ---------------------------------------------------------------------------------------------

  @Get('queries/form')
  @Doc({ summary: 'What the Raise a Query form needs: categories (Other last), settings and your contact details from your account' })
  async form() {
    const cats = await this.queries.queryCategories();
    const contact = await this.queries.contact();
    return { categories: cats.items, settings: cats.settings, contact };
  }

  @Post('files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: COMM_FILE_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a screenshot or file for a query or reply (multipart/form-data: file). Up to 10 MB.' })
  upload(@File() file?: UploadedFile) {
    return this.queries.upload(file);
  }

  @Post('queries')
  @Doc({ summary: 'Raise a query: category (or Other), subject, description, page or feature, attachments. Returns its ticket ID', body: helpQueryInput })
  raise(@Body(new ZodPipe(helpQueryInput)) body: HelpQueryInput) {
    return this.queries.raise(body);
  }

  @Get('queries')
  @Doc({ summary: 'The queries you raised, newest activity first, with counts by status', query: helpQueryListQuery })
  mine(@Query(new ZodPipe(helpQueryListQuery)) q: HelpQueryListQuery) {
    return this.queries.mine(q);
  }

  @Get('queries/:id')
  @Doc({ summary: 'One query you raised or handle, with its conversation (marks it seen)' })
  get(@Param('id', UuidPipe) id: string) {
    return this.queries.get(id);
  }

  @Post('queries/:id/replies')
  @Doc({ summary: 'Reply on a query (raiser: add information; handler: answer, or an internal note, optionally with a status)', body: helpReplyInput })
  reply(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpReplyInput)) body: HelpReplyInput) {
    return this.queries.reply(id, body);
  }

  @Put('queries/:id/status')
  @Doc({ summary: 'Change the status. Handlers: any status. The raiser: close it, or reopen a resolved query within the allowed days', body: helpStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpStatusInput)) body: z.infer<typeof helpStatusInput>) {
    return this.queries.status(id, body.status, body.note);
  }

  @Post('queries/:id/rating')
  @HttpCode(200)
  @Doc({ summary: 'Rate the answer to your resolved query (1 to 5)', body: helpRateInput })
  rate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpRateInput)) body: z.infer<typeof helpRateInput>) {
    return this.queries.rate(id, body.rating, body.comment);
  }

  @Post('queries/:id/files/:fileId/link')
  @Doc({ summary: 'A short-lived download link for a file on a query you can see' })
  fileLink(@Param('id', UuidPipe) id: string, @Param('fileId', UuidPipe) fileId: string) {
    return this.queries.fileLink(id, fileId);
  }

  // Queries inbox (HR Workspace and Super Workspace) ----------------------------------------------------------

  @Get('inbox')
  @Doc({ summary: 'Queries you handle: HR Workspace for its people, Super Workspace for HR Workspaces and the whole company', query: helpQueryListQuery })
  inbox(@Query(new ZodPipe(helpQueryListQuery)) q: HelpQueryListQuery) {
    return this.queries.inbox(q);
  }

  @Get('inbox/:id')
  @Doc({ summary: 'One query you handle (same as /help/queries/:id, under the inbox part)' })
  inboxGet(@Param('id', UuidPipe) id: string) {
    return this.queries.get(id);
  }

  @Post('inbox/:id/replies')
  @Doc({ summary: 'Answer a query you handle, or add an internal note', body: helpReplyInput })
  inboxReply(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpReplyInput)) body: HelpReplyInput) {
    return this.queries.reply(id, body);
  }

  @Put('inbox/:id/status')
  @Doc({ summary: 'Set the status of a query you handle', body: helpStatusInput })
  inboxStatus(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpStatusInput)) body: z.infer<typeof helpStatusInput>) {
    return this.queries.status(id, body.status, body.note);
  }

  @Put('inbox/:id/assignee')
  @Doc({ summary: 'Assign a query you handle to yourself or a colleague who handles it (null removes the assignee)', body: helpAssignInput })
  inboxAssign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpAssignInput)) body: z.infer<typeof helpAssignInput>) {
    return this.queries.assign(id, body.assigneeId);
  }

  @Post('inbox/:id/escalate')
  @HttpCode(200)
  @Doc({ summary: 'Escalate a query to the level above: HR Workspace to Super Workspace, Super Workspace to SampCrew Support', body: helpEscalateInput })
  inboxEscalate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpEscalateInput)) body: z.infer<typeof helpEscalateInput>) {
    return this.queries.escalate(id, body.reason);
  }
}

/** The Console's own help centre (Console Admin content) and the Help & Support manager. */
@Controller('platform/help')
export class PlatformHelpController {
  constructor(
    private readonly content: HelpContentService,
    private readonly queries: HelpQueriesService,
  ) {}

  @PlatformRealm()
  @Get()
  @Doc({ summary: 'The help centre for Console Admins' })
  async home() {
    const home = await this.content.consoleHome();
    return { ...home, queries: { raise: false, open: 0, inbox: true, waiting: (await this.queries.consoleWaiting()).waiting } };
  }

  @PlatformRealm()
  @Get('search')
  @Doc({ summary: 'Search the Console Admin help', query: helpSearchQuery })
  search(@Query(new ZodPipe(helpSearchQuery)) q: HelpSearchQuery) {
    return this.content.consoleSearch(q);
  }

  @PlatformRealm()
  @Get('categories/:key')
  @Doc({ summary: 'One Console Admin help category' })
  category(@Param('key', new ZodPipe(slugParam)) key: string) {
    return this.content.consoleCategory(key);
  }

  @PlatformRealm()
  @Get('articles/:slug')
  @Doc({ summary: 'One Console Admin help article' })
  article(@Param('slug', new ZodPipe(slugParam)) slug: string) {
    return this.content.consoleArticle(slug);
  }

  // Content manager -------------------------------------------------------------------------------------------

  @PlatformRealm('help:manage')
  @Get('manage')
  @Doc({ summary: 'Every help category, article (drafts too, with views and helpful votes), query category and the settings' })
  manage() {
    return this.content.manageList();
  }

  @PlatformRealm('help:manage')
  @Get('manage/insights')
  @Doc({ summary: 'Most read articles with helpful votes, queries by status and top query categories across all companies' })
  insights() {
    return this.content.insights();
  }

  @PlatformRealm('help:manage')
  @Post('manage/categories')
  @Doc({ summary: 'Create a help category or subcategory', body: helpCategoryInput })
  createCategory(@Body(new ZodPipe(helpCategoryInput)) body: HelpCategoryInput) {
    return this.content.createCategory(body);
  }

  @PlatformRealm('help:manage')
  @Put('manage/categories/:id')
  @Doc({ summary: 'Change a help category (a built-in one is then never changed by updates)', body: helpCategoryInput })
  updateCategory(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpCategoryInput)) body: HelpCategoryInput) {
    return this.content.updateCategory(id, body);
  }

  @PlatformRealm('help:manage')
  @Delete('manage/categories/:id')
  @Doc({ summary: 'Delete an empty help category' })
  deleteCategory(@Param('id', UuidPipe) id: string) {
    return this.content.deleteCategory(id);
  }

  @PlatformRealm('help:manage')
  @Get('manage/articles/:id')
  @Doc({ summary: 'One help article as stored, for editing' })
  manageArticle(@Param('id', UuidPipe) id: string) {
    return this.content.manageArticle(id);
  }

  @PlatformRealm('help:manage')
  @Post('manage/articles')
  @Doc({ summary: 'Create a FAQ, guide, tutorial, troubleshooting article or quick start', body: helpArticleInput })
  createArticle(@Body(new ZodPipe(helpArticleInput)) body: HelpArticleInput) {
    return this.content.createArticle(body);
  }

  @PlatformRealm('help:manage')
  @Put('manage/articles/:id')
  @Doc({ summary: 'Change a help article', body: helpArticleInput })
  updateArticle(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpArticleInput)) body: HelpArticleInput) {
    return this.content.updateArticle(id, body);
  }

  @PlatformRealm('help:manage')
  @Put('manage/articles/:id/status')
  @Doc({ summary: 'Publish or unpublish (draft) a help article', body: statusOnly })
  articleStatus(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(statusOnly)) body: z.infer<typeof statusOnly>) {
    return this.content.setArticleStatus(id, body.status);
  }

  @PlatformRealm('help:manage')
  @Delete('manage/articles/:id')
  @Doc({ summary: 'Delete a help article' })
  deleteArticle(@Param('id', UuidPipe) id: string) {
    return this.content.deleteArticle(id);
  }

  @PlatformRealm('help:manage')
  @Post('manage/query-categories')
  @Doc({ summary: 'Add a Raise a Query category', body: helpQueryCategoryInput })
  createQueryCategory(@Body(new ZodPipe(helpQueryCategoryInput)) body: HelpQueryCategoryInput) {
    return this.content.createQueryCategory(body);
  }

  @PlatformRealm('help:manage')
  @Put('manage/query-categories/:id')
  @Doc({ summary: 'Change a Raise a Query category (Other cannot be switched off)', body: helpQueryCategoryInput })
  updateQueryCategory(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpQueryCategoryInput)) body: HelpQueryCategoryInput) {
    return this.content.updateQueryCategory(id, body);
  }

  @PlatformRealm('help:manage')
  @Delete('manage/query-categories/:id')
  @Doc({ summary: 'Remove a Raise a Query category (old queries keep its name)' })
  deleteQueryCategory(@Param('id', UuidPipe) id: string) {
    return this.content.deleteQueryCategory(id);
  }

  @PlatformRealm('help:manage')
  @Put('manage/settings')
  @Doc({ summary: 'Help & Support settings: attachments, reopen days, escalation and the welcome text', body: helpSettingsInput })
  settings(@Body(new ZodPipe(helpSettingsInput)) body: HelpSettings) {
    return this.content.updateSettings(body);
  }

  // Help queries for the Console Admin team ------------------------------------------------------------------

  @PlatformRealm('help:answer')
  @Get('queries')
  @Doc({ summary: 'Help queries for SampCrew Support: from Super Workspaces, escalated, and SampCrew categories, across companies', query: helpQueryListQuery })
  list(@Query(new ZodPipe(helpQueryListQuery)) q: HelpQueryListQuery) {
    return this.queries.consoleList(q);
  }

  @PlatformRealm('help:answer')
  @Get('queries/waiting')
  @Doc({ summary: 'Open help queries nobody has picked up yet (Console menu badge)' })
  waiting() {
    return this.queries.consoleWaiting();
  }

  @PlatformRealm('help:answer')
  @Get('queries/:id')
  @Doc({ summary: 'One help query with its conversation and internal notes' })
  get(@Param('id', UuidPipe) id: string) {
    return this.queries.consoleGet(id);
  }

  @PlatformRealm('help:answer')
  @Post('queries/:id/replies')
  @Doc({ summary: 'Reply to a help query as SampCrew Support, or add an internal note', body: helpReplyInput })
  reply(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpReplyInput)) body: HelpReplyInput) {
    return this.queries.consoleReply(id, body);
  }

  @PlatformRealm('help:answer')
  @Put('queries/:id/status')
  @Doc({ summary: 'Set the status of a help query', body: helpStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(helpStatusInput)) body: z.infer<typeof helpStatusInput>) {
    return this.queries.consoleStatus(id, body.status, body.note);
  }

  @PlatformRealm('help:answer')
  @Put('queries/:id/assignee')
  @Doc({ summary: 'Assign a help query to a Console Admin (null removes the assignee)', body: adminAssign })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(adminAssign)) body: z.infer<typeof adminAssign>) {
    return this.queries.consoleAssign(id, body.assigneeId);
  }

  @PlatformRealm('help:answer')
  @Post('queries/:id/files/:fileId/link')
  @Doc({ summary: 'A short-lived download link for a file on a help query' })
  fileLink(@Param('id', UuidPipe) id: string, @Param('fileId', UuidPipe) fileId: string) {
    return this.queries.consoleFileLink(id, fileId);
  }
}

/**
 * The public Help & Support page: anyone can read it before signing in, from every sign-in page (Console, Super
 * Workspace, HR Workspace and Employee Workspace, and the phone app). Only content a Console Admin gave the public
 * audience, with no feature or permission; read-only, and nothing about the reader is stored.
 */
@Controller('public/help')
@Public()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class PublicHelpController {
  constructor(private readonly content: HelpContentService) {}

  @Get()
  @Doc({ summary: 'Public Help & Support: feature briefs, FAQs, articles and guides anyone can read before signing in' })
  home() {
    return this.content.publicHome();
  }

  @Get('search')
  @Doc({ summary: 'Search the public Help & Support content', query: helpSearchQuery })
  search(@Query(new ZodPipe(helpSearchQuery)) q: HelpSearchQuery) {
    return this.content.publicSearch(q);
  }

  @Get('articles/:slug')
  @Doc({ summary: 'One public help article, feature brief or FAQ' })
  article(@Param('slug', new ZodPipe(slugParam)) slug: string) {
    return this.content.publicArticle(slug);
  }
}
