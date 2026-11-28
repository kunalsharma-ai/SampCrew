import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  COMM_FILE_MAX_BYTES, leaveCancellationInput, requestApprovalsQuery, requestCancelInput, requestCommentInput, requestDecisionInput, requestInput, requestLeaveInput,
  requestListQuery, requestResubmitInput, requestSettingsInput,
  type RequestApprovalsQuery, type RequestDecisionInput, type RequestInput, type RequestLeaveInput, type RequestResubmitInput, type RequestSettingsInput,
} from '@crew/contracts';
import { z } from 'zod';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { RequestsService } from './requests.service';

const peopleQuery = z.object({ q: z.string().trim().max(100).optional() });

/**
 * Requests: work from home, leave, early leave, late arrival, comp off, attendance regularization and more, raised by
 * anyone at any level, decided by the approvers they choose (CC participants are told), as the category's workflow
 * says. My Requests and My Approvals read the same records.
 */
@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get('options')
  @Doc({ summary: 'What the Create Request and Apply for Leave forms fill in: you, your manager and HR, categories, suggested approvers, leave types and balances' })
  options() {
    return this.requests.options();
  }

  @Get('people')
  @Doc({ summary: 'The directory of people you can add as an approver or CC participant (name, designation, department, workspace)', query: peopleQuery })
  people(@Query(new ZodPipe(peopleQuery)) q: z.infer<typeof peopleQuery>) {
    return this.requests.people(q.q);
  }

  @Get('settings')
  @Doc({ summary: 'Request settings: categories, their workflows (one, all or one after another) and rules' })
  settings() {
    return this.requests.settings();
  }

  @Put('settings')
  @Doc({ summary: 'Save the request settings (Super Workspace)', body: requestSettingsInput })
  saveSettings(@Body(new ZodPipe(requestSettingsInput)) body: RequestSettingsInput) {
    return this.requests.saveSettings(body);
  }

  @Get('summary')
  @Doc({ summary: 'Menu badges: your requests waiting or sent back, and requests waiting for your decision' })
  summary() {
    return this.requests.summary();
  }

  @Get('my-day')
  @Doc({ summary: 'My Day: your own requests and the decisions you made lately' })
  myDay() {
    return this.requests.myDay();
  }

  @Get('approvals')
  @Doc({ summary: 'My Approvals: requests you approve (pending your approval, approved, rejected ...), with filters', query: requestApprovalsQuery })
  approvals(@Query(new ZodPipe(requestApprovalsQuery)) q: RequestApprovalsQuery) {
    return this.requests.approvalsList(q);
  }

  @Post('files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: COMM_FILE_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a supporting document for a request (multipart/form-data: file). Up to 10 MB.' })
  upload(@File() file?: UploadedFile) {
    return this.requests.uploadFile(file);
  }

  @Get()
  @Doc({ summary: 'My Requests: your requests, newest first', query: requestListQuery })
  mine(@Query(new ZodPipe(requestListQuery)) q: z.infer<typeof requestListQuery>) {
    return this.requests.mine(q);
  }

  @Post()
  @Doc({ summary: 'Raise a request: category, dates and times, reason, documents, primary and additional approvers and CC participants', body: requestInput })
  create(@Body(new ZodPipe(requestInput)) body: RequestInput) {
    return this.requests.create(body);
  }

  @Post('leave')
  @Doc({ summary: 'Apply for leave (full day, half day or hours): it goes straight to your approvers and is booked once fully approved', body: requestLeaveInput })
  applyLeave(@Body(new ZodPipe(requestLeaveInput)) body: RequestLeaveInput) {
    return this.requests.applyLeave(body);
  }

  @Get(':id')
  @Doc({ summary: 'One request with its approvers, CC participants, documents and history' })
  get(@Param('id', UuidPipe) id: string) {
    return this.requests.get(id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @Doc({ summary: 'Approve, reject (reason required) or request changes (comment required), as an approver', body: requestDecisionInput })
  decide(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requestDecisionInput)) body: RequestDecisionInput) {
    return this.requests.decide(id, body);
  }

  @Post(':id/comments')
  @Doc({ summary: 'Add a comment (requester, approvers and CC participants are told)', body: requestCommentInput })
  comment(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requestCommentInput)) body: z.infer<typeof requestCommentInput>) {
    return this.requests.comment(id, body.body);
  }

  @Post(':id/resubmit')
  @HttpCode(200)
  @Doc({ summary: 'Correct a request an approver sent back and send it to the same approvers again', body: requestResubmitInput })
  resubmit(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requestResubmitInput)) body: RequestResubmitInput) {
    return this.requests.resubmit(id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Doc({ summary: 'Cancel your request (waiting for a decision or corrections, or approved and not started; not approved leave)', body: requestCancelInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requestCancelInput)) body: z.infer<typeof requestCancelInput>) {
    return this.requests.cancel(id, body.reason);
  }

  @Post(':id/cancel-leave')
  @HttpCode(200)
  @Doc({ summary: 'Cancel approved leave: through your approvers, or straight away before it starts when the settings allow', body: leaveCancellationInput })
  cancelLeave(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveCancellationInput)) body: z.infer<typeof leaveCancellationInput>) {
    return this.requests.cancelLeave(id, body.reason);
  }

  @Post(':id/files/:fileId/link')
  @HttpCode(200)
  @Doc({ summary: 'A short-lived download link for a document on a request you can open' })
  fileLink(@Param('id', UuidPipe) id: string, @Param('fileId', UuidPipe) fileId: string) {
    return this.requests.fileLink(id, fileId);
  }
}
