import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CUSTOM_FIELD_ENTITIES, customFieldInput, customFieldReorder, customFieldUpdate, customFieldValuesInput, DOCUMENT_MAX_BYTES } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequirePermission } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../../platform/storage/uploads';
import { CustomFieldsService } from './custom-fields.service';

const listQuery = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
  archived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
const recordParams = z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES), recordId: z.uuid() });
const archiveBody = z.object({ archived: z.boolean() }).strict();
const fileMeta = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) });
const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });

/**
 * Custom fields: HR defines extra fields per kind of record (employee, asset, verification case, candidate,
 * leave request). Definitions are never dropped once they hold values: they are archived, and every change is audited.
 */
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @Doc({ summary: 'Field definitions (all kinds of record, or one); archived ones too with archived=true', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.fields.definitions(q.entity, q.archived);
  }

  @Get('history')
  @RequirePermission('fields:manage')
  @Doc({ summary: 'The audit trail of field definition changes' })
  history() {
    return this.fields.history();
  }

  @Post()
  @RequirePermission('fields:manage')
  @Doc({ summary: 'Add a custom field', body: customFieldInput })
  create(@Body(new ZodPipe(customFieldInput)) body: z.infer<typeof customFieldInput>) {
    return this.fields.create(body);
  }

  @Put('order')
  @RequirePermission('fields:manage')
  @Doc({ summary: 'Set the order fields are shown in', body: customFieldReorder })
  reorder(@Body(new ZodPipe(customFieldReorder)) body: z.infer<typeof customFieldReorder>) {
    return this.fields.reorder(body);
  }

  @Patch(':id')
  @RequirePermission('fields:manage')
  @Doc({ summary: 'Rename a field, change its type, options, rules or who may see and edit it (values are kept)', body: customFieldUpdate })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(customFieldUpdate)) body: z.infer<typeof customFieldUpdate>) {
    return this.fields.update(id, body);
  }

  @Post(':id/archive')
  @RequirePermission('fields:manage')
  @Doc({ summary: 'Archive a field (its values are kept and hidden) or bring it back', body: archiveBody })
  archive(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(archiveBody)) body: z.infer<typeof archiveBody>) {
    return this.fields.archive(id, body.archived);
  }

  @Delete(':id')
  @RequirePermission('fields:manage')
  @HttpCode(204)
  @Doc({ summary: 'Delete a field that never held a value (others are archived instead)' })
  async remove(@Param('id', UuidPipe) id: string) {
    await this.fields.remove(id);
  }

  @Get('values/:entity/:recordId')
  @Doc({ summary: 'A record’s custom field values that I may see, and which ones I may change' })
  values(@Param(new ZodPipe(recordParams)) p: z.infer<typeof recordParams>) {
    return this.fields.values(p.entity, p.recordId);
  }

  @Put('values/:entity/:recordId')
  @Doc({ summary: 'Save a record’s custom field values (only the ones I may change)', body: customFieldValuesInput })
  save(@Param(new ZodPipe(recordParams)) p: z.infer<typeof recordParams>, @Body(new ZodPipe(customFieldValuesInput)) body: z.infer<typeof customFieldValuesInput>) {
    return this.fields.save(p.entity, p.recordId, body.values);
  }

  @Post('values/:entity/:recordId/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload the file for a file field (multipart: file, key). Save the returned fileId as the value.' })
  upload(@Param(new ZodPipe(recordParams)) p: z.infer<typeof recordParams>, @Body(new ZodPipe(fileMeta)) meta: z.infer<typeof fileMeta>, @File() file?: UploadedFile) {
    return this.fields.uploadFile(p.entity, p.recordId, meta.key, file);
  }

  @Post('files/:fileId/link')
  @Doc({ summary: 'A 5-minute download link for a file field’s file' })
  link(@Param('fileId', UuidPipe) fileId: string) {
    return this.fields.fileLink(fileId);
  }
}

@Controller()
export class CustomFieldFilesController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get('files/fields/:id')
  @Public()
  @Doc({ summary: 'Download a custom field file through a signed link', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    const f = await this.fields.openFile(id, q.exp, q.sig);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-length', String(f.size));
    res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
    res.setHeader('cache-control', 'private, no-store');
    f.stream.pipe(res);
  }
}
