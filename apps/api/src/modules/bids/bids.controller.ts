import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import {
  bidInput, type BidInput, bidListQuery, bidOutcomeInput, bidSendInput, type BidSendInput, bidTemplateInput, type BidTemplateInput, clientInput, type ClientInput,
  proposalAcceptInput, type ProposalAcceptInput, proposalDeclineInput, type ProposalDeclineInput,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { Throttle } from '@nestjs/throttler';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { BidsService } from './bids.service';
import { ProposalsPublicService } from './proposals-public.service';

const clientQuery = z.object({ archived: z.enum(['true', 'false']).optional() });
const pdfQuery = z.object({ version: z.uuid().optional() });

@Controller('staffing')
@RequireFeature('recruitment')
export class BidsController {
  constructor(private readonly bids: BidsService) {}

  // Clients -----------------------------------------------------------------------------------------------

  @Get('clients')
  @RequirePermission('bids:read')
  @Doc({ summary: 'Clients that staffing bids are made to', query: clientQuery })
  clients(@Query(new ZodPipe(clientQuery)) q: z.infer<typeof clientQuery>) {
    return this.bids.clients(q.archived === 'true');
  }

  @Post('clients')
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Add a client', body: clientInput })
  createClient(@Body(new ZodPipe(clientInput)) body: ClientInput) {
    return this.bids.createClient(body);
  }

  @Put('clients/:id')
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Change a client', body: clientInput })
  updateClient(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(clientInput)) body: ClientInput) {
    return this.bids.updateClient(id, body);
  }

  @Delete('clients/:id')
  @HttpCode(204)
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Archive a client (their bids are kept)' })
  archiveClient(@Param('id', UuidPipe) id: string) {
    return this.bids.archiveClient(id);
  }

  // Templates ---------------------------------------------------------------------------------------------

  @Get('templates')
  @RequirePermission('bids:read')
  @Doc({ summary: 'Proposal templates: cover note, terms, validity and pricing defaults' })
  templates() {
    return this.bids.templates();
  }

  @Post('templates')
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Add a proposal template', body: bidTemplateInput })
  createTemplate(@Body(new ZodPipe(bidTemplateInput)) body: BidTemplateInput) {
    return this.bids.saveTemplate(null, body);
  }

  @Put('templates/:id')
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Change a proposal template (bids already made keep their own text)', body: bidTemplateInput })
  updateTemplate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bidTemplateInput)) body: BidTemplateInput) {
    return this.bids.saveTemplate(id, body);
  }

  @Delete('templates/:id')
  @HttpCode(204)
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Archive a proposal template' })
  archiveTemplate(@Param('id', UuidPipe) id: string) {
    return this.bids.archiveTemplate(id);
  }

  // Bids --------------------------------------------------------------------------------------------------

  @Get('bids')
  @RequirePermission('bids:read')
  @Doc({ summary: 'Staffing bids you can see, newest activity first', query: bidListQuery })
  list(@Query(new ZodPipe(bidListQuery)) q: z.infer<typeof bidListQuery>) {
    return this.bids.list(q);
  }

  @Post('bids')
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Create a staffing bid (Quick Bid or Advanced Bid); pricing is worked out on the server', body: bidInput })
  create(@Body(new ZodPipe(bidInput)) body: BidInput) {
    return this.bids.create(body);
  }

  @Get('bids/:id')
  @RequirePermission('bids:read')
  @Doc({ summary: 'A bid with its roles, pricing and margins, versions, approval and proposal emails' })
  get(@Param('id', UuidPipe) id: string) {
    return this.bids.get(id);
  }

  @Put('bids/:id')
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Change a bid. Changing an approved or sent bid starts a new version that needs approval again.', body: bidInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bidInput)) body: BidInput) {
    return this.bids.update(id, body);
  }

  @Delete('bids/:id')
  @HttpCode(204)
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Delete a draft that was never submitted' })
  remove(@Param('id', UuidPipe) id: string) {
    return this.bids.remove(id);
  }

  @Post('bids/:id/submit')
  @HttpCode(200)
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Submit a bid for approval (by default, anyone with the Finance Manager role)' })
  submit(@Param('id', UuidPipe) id: string) {
    return this.bids.submit(id);
  }

  @Post('bids/:id/outcome')
  @HttpCode(200)
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Record that a sent proposal was won or lost, or withdraw a bid', body: bidOutcomeInput })
  outcome(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bidOutcomeInput)) body: z.infer<typeof bidOutcomeInput>) {
    return this.bids.outcome(id, body);
  }

  @Post('bids/:id/send')
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Email the approved proposal (PDF attached) now or at a scheduled time', body: bidSendInput })
  send(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bidSendInput)) body: BidSendInput) {
    return this.bids.send(id, body);
  }

  @Post('bids/:id/emails/:emailId/cancel')
  @HttpCode(200)
  @RequirePermission('bids:manage')
  @Doc({ summary: 'Cancel a scheduled proposal email that has not gone yet' })
  cancelEmail(@Param('id', UuidPipe) id: string, @Param('emailId', UuidPipe) emailId: string) {
    return this.bids.cancelEmail(id, emailId);
  }

  @Get('bids/:id/proposal.pdf')
  @RequirePermission('bids:read')
  @Doc({ summary: 'The client proposal as PDF: a version as sent, or a preview of the bid now (no costs or margins)', query: pdfQuery })
  async pdf(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(pdfQuery)) q: z.infer<typeof pdfQuery>, @Res() res: Response) {
    sendPdf(res, await this.bids.pdf(id, q.version));
  }

  @Get('bids/:id/signed.pdf')
  @RequirePermission('bids:read')
  @Doc({ summary: 'The signed copy of a proposal accepted online: the PDF as sent plus the acceptance record' })
  async signed(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    const f = await this.bids.signedPdf(id);
    sendPdf(res, f);
  }
}

function sendPdf(res: Response, f: { fileName: string; content: Buffer }) {
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="${f.fileName}"`);
  res.setHeader('cache-control', 'private, no-store');
  res.send(f.content);
}

/** The client's side: the private link in a proposal email. No sign-in; the link is the credential. */
@Controller('public/proposals')
@Public()
export class ProposalsPublicController {
  constructor(private readonly proposals: ProposalsPublicService) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Doc({ summary: 'A proposal as the client sees it: roles, rates and totals, and whether it is still open' })
  get(@Param('token') token: string) {
    return this.proposals.get(String(token));
  }

  @Get(':token/proposal.pdf')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Doc({ summary: 'The proposal PDF the link was sent with, or the signed copy once accepted' })
  async pdf(@Param('token') token: string, @Res() res: Response) {
    sendPdf(res, await this.proposals.pdf(String(token)));
  }

  @Post(':token/accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Doc({ summary: 'Accept the proposal with a typed signature; the bid is marked won and a signed copy is kept', body: proposalAcceptInput })
  accept(@Param('token') token: string, @Body(new ZodPipe(proposalAcceptInput)) body: ProposalAcceptInput) {
    return this.proposals.accept(String(token), body);
  }

  @Post(':token/decline')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Doc({ summary: 'Decline the proposal with a reason; the bid is marked lost', body: proposalDeclineInput })
  decline(@Param('token') token: string, @Body(new ZodPipe(proposalDeclineInput)) body: ProposalDeclineInput) {
    return this.proposals.decline(String(token), body);
  }
}
