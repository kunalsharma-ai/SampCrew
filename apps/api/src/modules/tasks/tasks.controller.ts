import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DOCUMENT_MAX_BYTES, documentVerifyInput, taskInput, type TaskInput, taskListQuery, taskProgressInput, taskReviewInput, taskUpdateInput } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { TasksService } from './tasks.service';

const uploadMeta = z.object({ remarks: z.string().trim().max(2000).optional().nullable() });

/** HR Tasks and Manager Tasks. Who may do what is decided per task (the employee, the assigner, HR). */
@Controller('tasks')
@RequireFeature('core_hr')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @Doc({ summary: 'My tasks (scope=mine) or the tasks of people I assign to (scope=assigned), by category and status', query: taskListQuery })
  list(@Query(new ZodPipe(taskListQuery)) q: z.infer<typeof taskListQuery>) {
    return this.tasks.list(q);
  }

  @Get('counts')
  @Doc({ summary: 'Open, new, overdue and in-review counts for HR Tasks and Manager Tasks, plus what is waiting for my review' })
  counts() {
    return this.tasks.counts();
  }

  @Get('assignable')
  @Doc({ summary: 'People I can assign HR Tasks or Manager Tasks to' })
  assignable() {
    return this.tasks.assignable();
  }

  @Post()
  @Doc({ summary: 'Assign a task to one or more people (each gets their own copy)', body: taskInput })
  create(@Body(new ZodPipe(taskInput)) body: TaskInput) {
    return this.tasks.create(body);
  }

  @Get(':id')
  @Doc({ summary: 'One task with its history and document check' })
  get(@Param('id', UuidPipe) id: string) {
    return this.tasks.get(id);
  }

  @Patch(':id')
  @Doc({ summary: 'Change the title, description, priority or due date (the assigner or HR)', body: taskUpdateInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(taskUpdateInput)) body: z.infer<typeof taskUpdateInput>) {
    return this.tasks.update(id, body);
  }

  @Post(':id/seen')
  @HttpCode(200)
  @Doc({ summary: 'Mark my task as opened, so it no longer counts as new' })
  seen(@Param('id', UuidPipe) id: string) {
    return this.tasks.seen(id);
  }

  @Post(':id/progress')
  @HttpCode(200)
  @Doc({ summary: 'Update progress on my task: not started, in progress, send for review, or completed (general and acknowledgement tasks)', body: taskProgressInput })
  progress(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(taskProgressInput)) body: z.infer<typeof taskProgressInput>) {
    return this.tasks.progress(id, body);
  }

  @Post(':id/review')
  @HttpCode(200)
  @Doc({ summary: 'Accept, reopen (with a reason) or cancel a task I assigned or manage', body: taskReviewInput })
  review(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(taskReviewInput)) body: z.infer<typeof taskReviewInput>) {
    return this.tasks.review(id, body);
  }

  @Post(':id/document')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload the document an HR task asks for (multipart/form-data: file, remarks). It goes to HR to verify.' })
  upload(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(uploadMeta)) body: z.infer<typeof uploadMeta>, @File() file?: UploadedFile) {
    return this.tasks.upload(id, file, body.remarks);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @Doc({ summary: 'Verify or reject the uploaded document (HR). Rejecting reopens the task with your remarks.', body: documentVerifyInput })
  verify(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(documentVerifyInput)) body: z.infer<typeof documentVerifyInput>) {
    return this.tasks.verify(id, body);
  }
}
