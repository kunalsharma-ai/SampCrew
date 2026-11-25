import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  audienceInput,
  type AudienceInput,
  chatEditInput,
  type ChatEditInput,
  chatMessageInput,
  type ChatMessageInput,
  chatMessagesQuery,
  chatReactionInput,
  type ChatReactionInput,
  chatSearchQuery,
  COMM_FILE_MAX_BYTES,
  commGroupInput,
  type CommGroupInput,
  CONVERSATION_KINDS,
  conversationInput,
  type ConversationInput,
  emailDraftInput,
  type EmailDraftInput,
  emailListQuery,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { ChatService } from './chat.service';
import { CommunicationService } from './communication.service';
import { CommEmailService } from './email.service';
import { CommFilesService } from './files.service';

const conversationsQuery = z.object({ q: z.string().trim().max(80).optional(), kind: z.enum(CONVERSATION_KINDS).optional() });
const peopleQuery = z.object({ q: z.string().trim().max(80).optional() });
const manageInput = z.object({ title: z.string().trim().min(2).max(80).optional(), add: z.array(z.uuid()).max(200).optional(), remove: z.array(z.uuid()).max(200).optional() });
const muteInput = z.object({ muted: z.boolean() });
const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });

/**
 * Communication: chat for everyone in the workspace (helpdesk:use), and for the HR team (helpdesk:manage) emails,
 * groups, the dashboard and each employee's communication record. Ask HR's cases stay under /helpdesk.
 */
@Controller('communication')
@RequireFeature('helpdesk')
export class CommunicationController {
  constructor(
    private readonly chat: ChatService,
    private readonly emails: CommEmailService,
    private readonly comm: CommunicationService,
    private readonly files: CommFilesService,
  ) {}

  // Chat ---------------------------------------------------------------------------------------------------

  @Get('conversations')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Your conversations, newest first, with unread counts; marks waiting messages delivered', query: conversationsQuery })
  conversations(@Query(new ZodPipe(conversationsQuery)) q: z.infer<typeof conversationsQuery>) {
    return this.chat.conversations(q);
  }

  @Get('unread')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Unread chat messages across your conversations (menu badge)' })
  unread() {
    return this.chat.unread();
  }

  @Post('conversations')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Start a conversation: direct, group, department (HR) or with the HR team; returns an existing direct or HR conversation', body: conversationInput })
  open(@Body(new ZodPipe(conversationInput)) body: ConversationInput) {
    return this.chat.open(body);
  }

  @Get('conversations/:id')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'One conversation and its latest messages, oldest first; page back with `before`', query: chatMessagesQuery })
  conversation(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(chatMessagesQuery)) q: z.infer<typeof chatMessagesQuery>) {
    return this.chat.conversation(id, q);
  }

  @Post('conversations/:id/messages')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Send a message (text and up to 5 uploaded files); a repeated clientId returns the first message', body: chatMessageInput })
  send(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(chatMessageInput)) body: ChatMessageInput) {
    return this.chat.send(id, body);
  }

  @Delete('conversations/:id/messages/:messageId')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Delete your own message' })
  deleteMessage(@Param('id', UuidPipe) id: string, @Param('messageId', UuidPipe) messageId: string) {
    return this.chat.deleteMessage(id, messageId);
  }

  @Patch('conversations/:id/messages/:messageId')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Edit your own message (for 15 minutes after sending); it shows as Edited', body: chatEditInput })
  editMessage(@Param('id', UuidPipe) id: string, @Param('messageId', UuidPipe) messageId: string, @Body(new ZodPipe(chatEditInput)) body: ChatEditInput) {
    return this.chat.editMessage(id, messageId, body);
  }

  @Post('conversations/:id/messages/:messageId/restore')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Undo deleting a message (for 30 seconds, by the person who deleted it)' })
  restoreMessage(@Param('id', UuidPipe) id: string, @Param('messageId', UuidPipe) messageId: string) {
    return this.chat.restoreMessage(id, messageId);
  }

  @Put('conversations/:id/messages/:messageId/reactions')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Add your emoji reaction to a message, or take it away when you already reacted with it', body: chatReactionInput })
  react(@Param('id', UuidPipe) id: string, @Param('messageId', UuidPipe) messageId: string, @Body(new ZodPipe(chatReactionInput)) body: ChatReactionInput) {
    return this.chat.react(id, messageId, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Mark the conversation read up to now (clears its notification; others see Read)' })
  read(@Param('id', UuidPipe) id: string) {
    return this.chat.read(id);
  }

  @Post('delivered')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Your app received new messages (senders see Delivered)' })
  delivered() {
    return this.chat.delivered();
  }

  @Put('conversations/:id')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Rename a group or department conversation, or add and remove group members (its owner)', body: manageInput })
  manage(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(manageInput)) body: z.infer<typeof manageInput>) {
    return this.chat.manage(id, body);
  }

  @Post('conversations/:id/leave')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Leave a group' })
  leave(@Param('id', UuidPipe) id: string) {
    return this.chat.leave(id);
  }

  @Put('conversations/:id/mute')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Mute or unmute a conversation for you', body: muteInput })
  mute(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(muteInput)) body: z.infer<typeof muteInput>) {
    return this.chat.mute(id, body.muted);
  }

  @Get('search')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Search messages in your conversations', query: chatSearchQuery })
  search(@Query(new ZodPipe(chatSearchQuery)) q: z.infer<typeof chatSearchQuery>) {
    return this.chat.search(q.q);
  }

  @Get('people')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'People you can message, with department and designation', query: peopleQuery })
  people(@Query(new ZodPipe(peopleQuery)) q: z.infer<typeof peopleQuery>) {
    return this.chat.people(q.q);
  }

  // Files --------------------------------------------------------------------------------------------------

  @Post('files')
  @RequirePermission('helpdesk:use')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: COMM_FILE_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a file to attach to a message, email or announcement (multipart/form-data: file). Up to 10 MB.' })
  upload(@File() file?: UploadedFile) {
    return this.files.upload(file);
  }

  @Post('files/:id/link')
  @HttpCode(200)
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'A 5-minute download link for a file you can see (audited)' })
  link(@Param('id', UuidPipe) id: string) {
    return this.files.link(id);
  }

  // Email (HR) ---------------------------------------------------------------------------------------------

  @Get('emails')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'HR emails: drafts and sent, with delivery counts', query: emailListQuery })
  emailList(@Query(new ZodPipe(emailListQuery)) q: z.infer<typeof emailListQuery>) {
    return this.emails.list(q);
  }

  @Get('emails/inbox')
  @RequirePermission('helpdesk:use')
  @Doc({ summary: 'Emails from HR that you were sent' })
  inbox() {
    return this.emails.inbox();
  }

  @Get('emails/:id')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'One email with every recipient and their delivery status' })
  email(@Param('id', UuidPipe) id: string) {
    return this.emails.get(id);
  }

  @Post('emails')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Save a new draft', body: emailDraftInput })
  createDraft(@Body(new ZodPipe(emailDraftInput)) body: EmailDraftInput) {
    return this.emails.saveDraft(null, body);
  }

  @Put('emails/:id')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Change a draft', body: emailDraftInput })
  updateDraft(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(emailDraftInput)) body: EmailDraftInput) {
    return this.emails.saveDraft(id, body);
  }

  @Delete('emails/:id')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Delete a draft (sent emails are kept)' })
  deleteDraft(@Param('id', UuidPipe) id: string) {
    return this.emails.deleteDraft(id);
  }

  @Post('emails/send')
  @HttpCode(200)
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Send a new email straight away', body: emailDraftInput })
  sendNew(@Body(new ZodPipe(emailDraftInput)) body: EmailDraftInput) {
    return this.emails.send(null, body);
  }

  @Post('emails/:id/send')
  @HttpCode(200)
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Send a draft, with the content given', body: emailDraftInput })
  sendDraft(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(emailDraftInput)) body: EmailDraftInput) {
    return this.emails.send(id, body);
  }

  // Groups, audience, dashboard, employee record (HR) -----------------------------------------------------------

  @Get('groups')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'HR groups of people (an audience for emails and announcements)' })
  groups() {
    return this.comm.groups();
  }

  @Post('groups')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Add a group', body: commGroupInput })
  addGroup(@Body(new ZodPipe(commGroupInput)) body: CommGroupInput) {
    return this.comm.saveGroup(null, body);
  }

  @Put('groups/:id')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Change a group', body: commGroupInput })
  updateGroup(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(commGroupInput)) body: CommGroupInput) {
    return this.comm.saveGroup(id, body);
  }

  @Post('groups/:id/chat')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: "Open the group's chat (made with the group's members the first time)" })
  groupChat(@Param('id', UuidPipe) id: string) {
    return this.chat.groupChat(id);
  }

  @Delete('groups/:id')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Remove a group' })
  archiveGroup(@Param('id', UuidPipe) id: string) {
    return this.comm.archiveGroup(id);
  }

  @Post('audience/preview')
  @HttpCode(200)
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'How many people an audience reaches now', body: audienceInput })
  preview(@Body(new ZodPipe(audienceInput)) body: AudienceInput) {
    return this.comm.preview(body);
  }

  @Get('dashboard')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Communication dashboard: email delivery, chat activity, conversations waiting for HR, open help requests' })
  dashboard() {
    return this.comm.dashboard();
  }

  @Get('employees/:employeeId')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'One employee’s communication record: emails, HR conversation, help requests' })
  employee(@Param('employeeId', UuidPipe) employeeId: string) {
    return this.comm.employeeRecord(employeeId);
  }
}

@Controller('files/comm')
export class CommFilesController {
  constructor(private readonly files: CommFilesService) {}

  @Get(':id')
  @Public()
  @Doc({ summary: 'Download a communication file through a signed link', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    const f = await this.files.open(id, q.exp, q.sig);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-length', String(f.size));
    res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    f.stream.pipe(res);
  }
}
