import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { iqAskInput, type IqAskInput } from '@crew/contracts';
import { Throttle } from '@nestjs/throttler';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { IqService } from './iq.service';

@Controller('iq')
export class IqController {
  constructor(private readonly iq: IqService) {}

  @Post('ask')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Doc({ summary: 'Ask CREW IQ. Answers come from your workspace under your own permissions, with how they were found and links to the source pages; actions open prefilled forms and change nothing.', body: iqAskInput })
  ask(@Body(new ZodPipe(iqAskInput)) body: IqAskInput) {
    return this.iq.ask(body.question);
  }
}
