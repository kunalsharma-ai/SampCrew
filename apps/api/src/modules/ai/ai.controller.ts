import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { AI_FEATURES, aiFeedbackInput, type AiFeedbackInput, aiSettingsInput, type AiSettingsInput, assistantAskInput } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AiService } from './ai.service';
import { AssistantService } from './assistant.service';

const logQuery = z.object({
  feature: z.enum(AI_FEATURES).optional(),
  status: z.enum(['ok', 'no_sources', 'refused', 'error', 'over_limit']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService, private readonly assistant: AssistantService) {}

  @Get('status')
  @RequirePermission('ai:use')
  @Doc({ summary: 'Whether AI is set up, and which AI features the signed-in person can use right now (with the reason when not)' })
  status() {
    return this.ai.status();
  }

  @Post('assistant')
  @HttpCode(200)
  @RequireFeature('ai_copilot')
  @RequirePermission('ai:use')
  @Doc({ summary: 'Ask the HR assistant. Answers come only from published help articles, with citations; with no matching article, no model is called.', body: assistantAskInput })
  ask(@Body(new ZodPipe(assistantAskInput)) body: z.infer<typeof assistantAskInput>) {
    return this.assistant.ask(body.question);
  }

  @Post('helpdesk/cases/:id/draft')
  @HttpCode(200)
  @RequireFeature('ai_copilot')
  @RequirePermission('helpdesk:manage')
  @Doc({ summary: 'Draft a reply to a helpdesk case for the handler to edit and send. Not available for confidential cases; nothing is sent.' })
  draft(@Param('id', UuidPipe) id: string) {
    return this.assistant.draftReply(id);
  }

  @Post('interactions/:id/feedback')
  @HttpCode(200)
  @RequirePermission('ai:use')
  @Doc({ summary: 'Say whether an AI answer you received was helpful', body: aiFeedbackInput })
  feedback(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(aiFeedbackInput)) body: AiFeedbackInput) {
    return this.ai.feedback(id, body);
  }

  @Get('settings')
  @RequirePermission('ai:configure')
  @Doc({ summary: 'AI provider status, the workspace\'s AI feature switches, prompt retention and this month\'s credits' })
  settings() {
    return this.ai.getSettings();
  }

  @Put('settings')
  @RequirePermission('ai:configure')
  @Doc({ summary: 'Switch AI features on or off and set how long prompts are kept', body: aiSettingsInput })
  updateSettings(@Body(new ZodPipe(aiSettingsInput)) body: AiSettingsInput) {
    return this.ai.updateSettings(body);
  }

  @Get('usage')
  @RequirePermission('ai:configure')
  @Doc({ summary: 'AI calls, credits, tokens, response time and feedback this month, by feature' })
  usage() {
    return this.ai.usageReport();
  }

  @Get('interactions')
  @RequirePermission('audit:read')
  @Doc({ summary: 'Log of AI calls (auditors)', query: logQuery })
  interactions(@Query(new ZodPipe(logQuery)) q: z.infer<typeof logQuery>) {
    return this.ai.interactions(q);
  }

  @Get('interactions/:id')
  @RequirePermission('audit:read')
  @Doc({ summary: 'One AI call in full: what was sent after redaction, the answer, its sources and usage (auditors; the view is audited)' })
  interaction(@Param('id', UuidPipe) id: string) {
    return this.ai.interaction(id);
  }
}
