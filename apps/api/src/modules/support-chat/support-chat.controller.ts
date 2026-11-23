import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  chatMessagesQuery,
  supportConversationInput,
  supportListQuery,
  supportMessageInput,
  supportStatusInput,
  type SupportConversationInput,
  type SupportListQuery,
  type SupportMessageInput,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AllowWhenLocked, PlatformRealm } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { LiveService } from '../../platform/notify/live.service';
import { Doc } from '../../platform/openapi/openapi';
import { SupportChatService } from './support-chat.service';

const STREAM_MAX_MS = 15 * 60_000;
const HEARTBEAT_MS = 25_000;
const beforeQuery = chatMessagesQuery.pick({ before: true });
const readInput = z.object({ read: z.boolean().default(true) });

/**
 * SampCrew Support for a company: its Super Workspace's private chat with the Console Admin team. Every plan has it,
 * and it keeps working while a subscription is locked (that is when people most need to reach SAMPLEDGE). The
 * service refuses HR Workspace and Employee Workspace members.
 */
@Controller('support')
@AllowWhenLocked()
export class SupportChatController {
  constructor(private readonly support: SupportChatService) {}

  @Get('conversations')
  @Doc({ summary: "Your company's conversations with SampCrew Support (Super Workspace only), newest first", query: supportListQuery })
  list(@Query(new ZodPipe(supportListQuery)) q: SupportListQuery) {
    return this.support.workspaceList(q);
  }

  @Get('unread')
  @Doc({ summary: 'Unread replies from SampCrew Support (0 and allowed=false for anyone not on the Super Workspace level)' })
  unread() {
    return this.support.workspaceUnread();
  }

  @Post('conversations')
  @Doc({ summary: 'Start a conversation with SampCrew Support: subject, category and the first message', body: supportConversationInput })
  start(@Body(new ZodPipe(supportConversationInput)) body: SupportConversationInput) {
    return this.support.workspaceStart(body);
  }

  @Get('conversations/:id')
  @Doc({ summary: 'One support conversation and its messages, oldest first; page back with `before`', query: beforeQuery })
  conversation(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(beforeQuery)) q: z.infer<typeof beforeQuery>) {
    return this.support.workspaceConversation(id, q.before);
  }

  @Post('conversations/:id/messages')
  @Doc({ summary: 'Send a message to SampCrew Support; a repeated clientId returns the first message', body: supportMessageInput })
  send(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(supportMessageInput)) body: SupportMessageInput) {
    return this.support.workspaceSend(id, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  @Doc({ summary: 'You have read the conversation: clears its unread count and notification; the Console sees Read' })
  read(@Param('id', UuidPipe) id: string) {
    return this.support.workspaceRead(id);
  }

  @Put('conversations/:id/status')
  @Doc({ summary: 'Mark the conversation resolved, or reopen it', body: supportStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(supportStatusInput)) body: z.infer<typeof supportStatusInput>) {
    return this.support.workspaceStatus(id, body.status);
  }
}

/** The Console Admin team's support inbox: every Super Workspace's conversations, answered by any authorised admin. */
@Controller('platform/support')
export class PlatformSupportChatController {
  constructor(
    private readonly support: SupportChatService,
    private readonly live: LiveService,
  ) {}

  @PlatformRealm('support:chat')
  @Get('conversations')
  @Doc({ summary: 'Support inbox: conversations from every Super Workspace, with state counts; search and filter', query: supportListQuery })
  list(@Query(new ZodPipe(supportListQuery)) q: SupportListQuery) {
    return this.support.consoleList(q);
  }

  @PlatformRealm('support:chat')
  @Get('unread')
  @Doc({ summary: 'Unread messages from Super Workspaces (Console menu badge)' })
  unread() {
    return this.support.consoleUnread();
  }

  @PlatformRealm('support:chat')
  @Get('conversations/:id')
  @Doc({ summary: 'One support conversation with the Super Workspace that wrote it', query: beforeQuery })
  conversation(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(beforeQuery)) q: z.infer<typeof beforeQuery>) {
    return this.support.consoleDetail(id, q.before);
  }

  @PlatformRealm('support:chat')
  @Post('conversations/:id/messages')
  @Doc({ summary: 'Reply to a Super Workspace as the Console Admin team (your name is recorded on the message)', body: supportMessageInput })
  send(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(supportMessageInput)) body: SupportMessageInput) {
    return this.support.consoleSend(id, body);
  }

  @PlatformRealm('support:chat')
  @Post('conversations/:id/read')
  @HttpCode(200)
  @Doc({ summary: 'Mark the conversation read (or unread again with read=false) for the whole Console Admin team', body: readInput })
  read(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(readInput)) body: z.infer<typeof readInput>) {
    return this.support.consoleRead(id, body.read);
  }

  @PlatformRealm('support:chat')
  @Put('conversations/:id/status')
  @Doc({ summary: 'Mark the conversation resolved, or reopen it', body: supportStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(supportStatusInput)) body: z.infer<typeof supportStatusInput>) {
    return this.support.consoleStatus(id, body.status);
  }

  /** Server-sent events for the support inbox. The Console proxies it at /live. Closes after 15 minutes; the browser reconnects. */
  @PlatformRealm('support:chat')
  @Get('stream')
  @Doc({ summary: 'Live support inbox updates (text/event-stream): new messages, reads and status changes' })
  stream(@Req() req: Request, @Res() res: Response) {
    const admin = requestContext.platformActor();
    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const sub = this.live.subscribeConsole(admin.adminId).subscribe((m) => send(m.type, { ...m.data, tenantId: m.tenantId }));
    send('ready', { at: new Date().toISOString() });
    const beat = setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS);
    const end = setTimeout(() => res.end(), STREAM_MAX_MS);
    const close = () => {
      clearInterval(beat);
      clearTimeout(end);
      sub.unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
  }
}
