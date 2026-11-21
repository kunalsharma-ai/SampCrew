import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DOCUMENT_MAX_BYTES, documentMetaInput, documentRepositoryQuery, type DocumentRepositoryQuery } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { DocumentsService, type UploadedFile } from './documents.service';
import { DocumentCenterService } from '../document-center/document-center.service';
import { contentDisposition } from '../../platform/http/content-disposition';

const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService, private readonly center: DocumentCenterService) {}

  @Get('employees/:id/documents')
  @RequireFeature('documents')
  @Doc({ summary: "An employee's documents (the Documents section of the profile), within Super Workspace's document access switches" })
  list(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(documentRepositoryQuery)) q: DocumentRepositoryQuery) {
    return this.center.employeeDocuments(id, q);
  }

  @Post('employees/:id/documents')
  @RequireFeature('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a document (multipart/form-data: file, category, title, visibility). PDF, images, Word or text, up to 10 MB.' })
  async upload(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(documentMetaInput)) meta: z.infer<typeof documentMetaInput>, @File() file?: UploadedFile) {
    await this.center.assertMayManageProfile(id);
    return this.documents.upload(id, meta, file);
  }

  @Post('documents/:id/link')
  @RequireFeature('documents')
  @Doc({ summary: 'Get a download link valid for 5 minutes (checked against the document access switches and recorded)' })
  link(@Param('id', UuidPipe) id: string) {
    return this.center.link(id, 'download');
  }

  @Delete('documents/:id')
  @RequireFeature('documents')
  @HttpCode(204)
  @Doc({ summary: 'Archive a document (the file is retained)' })
  async archive(@Param('id', UuidPipe) id: string) {
    await this.center.assertMayArchive(id);
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
