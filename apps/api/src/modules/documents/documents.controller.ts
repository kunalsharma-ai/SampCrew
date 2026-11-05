import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DOCUMENT_MAX_BYTES, documentMetaInput } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { DocumentsService, type UploadedFile } from './documents.service';
import { contentDisposition } from '../../platform/http/content-disposition';

const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('employees/:id/documents')
  @Doc({ summary: "An employee's documents (HR-only documents are listed for people who manage documents)" })
  list(@Param('id', UuidPipe) id: string) {
    return this.documents.list(id);
  }

  @Post('employees/:id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a document (multipart/form-data: file, category, title, visibility). PDF, images, Word or text, up to 10 MB.' })
  upload(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(documentMetaInput)) meta: z.infer<typeof documentMetaInput>, @File() file?: UploadedFile) {
    return this.documents.upload(id, meta, file);
  }

  @Post('documents/:id/link')
  @Doc({ summary: 'Get a download link valid for 5 minutes' })
  link(@Param('id', UuidPipe) id: string) {
    return this.documents.link(id);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @Doc({ summary: 'Archive a document (the file is retained)' })
  async archive(@Param('id', UuidPipe) id: string) {
    await this.documents.archive(id);
  }

  @Get('files/:id')
  @Public()
  @Doc({ summary: 'Download through a signed link', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    const f = await this.documents.open(id, q.exp, q.sig);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-length', String(f.size));
    res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
    res.setHeader('cache-control', 'private, no-store');
    f.stream.pipe(res);
  }
}
