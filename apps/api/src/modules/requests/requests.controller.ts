import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { requestCancelInput, requestInput, requestLeaveApplicationInput, requestListQuery, type RequestInput, type RequestLeaveApplicationInput } from '@crew/contracts';
import { z } from 'zod';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { RequestsService } from './requests.service';

const peopleQuery = z.object({ q: z.string().trim().max(100).optional() });

/**
 * Requests: work from home, early leave, late coming, comp off, leave and more, raised by anyone at any level and
 * decided by the people they loop in (in Approvals). Approved leave requests lead to the leave application form.
 */
@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get('options')
  @Doc({ summary: 'Request types, who you are, the people suggested to loop in (reporting manager, HR, Super Workspace) and your leave types' })
  options() {
    return this.requests.options();
  }

  @Get('people')
  @Doc({ summary: 'Anyone active in the workspace you can loop into a request, with their level', query: peopleQuery })
  people(@Query(new ZodPipe(peopleQuery)) q: z.infer<typeof peopleQuery>) {
    return this.requests.people(q.q);
  }

  @Get('summary')
  @Doc({ summary: 'Your pending requests, and approved leave requests waiting for you to apply' })
  summary() {
    return this.requests.summary();
  }

  @Get()
  @Doc({ summary: 'Your requests, newest first, with each approver and their comment', query: requestListQuery })
  mine(@Query(new ZodPipe(requestListQuery)) q: z.infer<typeof requestListQuery>) {
    return this.requests.mine(q);
  }

  @Post()
  @Doc({ summary: 'Raise a request: type, reason, dates and times, and the people to loop in (all of them approve)', body: requestInput })
  create(@Body(new ZodPipe(requestInput)) body: RequestInput) {
    return this.requests.create(body);
  }

  @Get(':id')
  @Doc({ summary: 'One request (the requester, the people looped in, or the Super Workspace)' })
  get(@Param('id', UuidPipe) id: string) {
    return this.requests.get(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Doc({ summary: 'Cancel your request (pending, or approved and not started yet)', body: requestCancelInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requestCancelInput)) body: z.infer<typeof requestCancelInput>) {
    return this.requests.cancel(id, body.reason);
  }

  @Get(':id/leave-form')
  @Doc({ summary: 'The leave application form for an approved leave request, filled in with your details, manager, HR, leave types and the approved days' })
  leaveForm(@Param('id', UuidPipe) id: string) {
    return this.requests.leaveForm(id);
  }

  @Post(':id/leave')
  @Doc({ summary: 'Apply for the leave of an approved request: it goes to the same people (Approvals and email) and is saved with the form', body: requestLeaveApplicationInput })
  applyLeave(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requestLeaveApplicationInput)) body: RequestLeaveApplicationInput) {
    return this.requests.applyLeave(id, body);
  }
}
