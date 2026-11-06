import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { iqAskInput, type IqAskInput } from '@crew/contracts';
import { Throttle } from '@nestjs/throttler';
import { RequireFeature } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { IqService } from './iq.service';

@Controller('iq')
@RequireFeature('crew_iq')
export class IqController {
  constructor(private readonly iq: IqService) {}

  @Post('ask')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Doc({ summary: 'Ask SampCrew IQ. Answers come from your workspace under your own permissions, with how they were found and links to the source pages; actions open prefilled forms and change nothing. Saved to your conversation; pass conversationId to ask a follow-up.', body: iqAskInput })
  ask(@Body(new ZodPipe(iqAskInput)) body: IqAskInput) {
    return this.iq.ask(body.question, body.conversationId);
  }

  @Get('conversations')
  @Doc({ summary: 'Your SampCrew IQ conversations, newest first (only your own)' })
  conversations() {
    return this.iq.conversations();
  }

  @Get('conversations/:id')
  @Doc({ summary: 'One of your SampCrew IQ conversations with every question and answer' })
  conversation(@Param('id', UuidPipe) id: string) {
    return this.iq.conversation(id);
  }

  @Delete('conversations/:id')
  @Doc({ summary: 'Delete one of your SampCrew IQ conversations' })
  forget(@Param('id', UuidPipe) id: string) {
    return this.iq.forget(id);
  }

  @Delete('conversations')
  @Doc({ summary: 'Delete all your SampCrew IQ conversations' })
  forgetAll() {
    return this.iq.forget(null);
  }
}
