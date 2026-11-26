import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  DOCUMENT_MAX_BYTES, documentAccessInput, documentCancelInput, documentCategoryInput, documentDecisionInput, documentRepositoryQuery, documentRequestInput, documentRequestQuery,
  documentSubmitMeta, documentTypeInput, type DocumentRequestInput, type DocumentRepositoryQuery,
} from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { DocumentCenterService } from './document-center.service';

const scopeKey = z.union([z.literal('central'), z.uuid()]);
const linkInput = z.object({ mode: z.enum(['preview', 'download']).default('download') });
const activityQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/** Centralized document management: requests, verification, profile repositories, access switches. */
@Controller()
@RequireFeature('documents')
export class DocumentCenterController {
  constructor(private readonly center: DocumentCenterService) {}

  // Catalogue
  @Get('documents/catalogue')
  @Doc({ summary: 'Document categories and types (built-in and custom)' })
  catalogue() {
    return this.center.getCatalogue();
  }

  @Post('documents/catalogue/categories')
  @Doc({ summary: 'Add a custom document category (Super Workspace)', body: documentCategoryInput })
  addCategory(@Body(new ZodPipe(documentCategoryInput)) body: z.infer<typeof documentCategoryInput>) {
    return this.center.addCategory(body);
  }

  @Post('documents/catalogue/types')
  @Doc({ summary: 'Add a custom document type', body: documentTypeInput })
  addType(@Body(new ZodPipe(documentTypeInput)) body: z.infer<typeof documentTypeInput>) {
    return this.center.addType(body);
  }

  // Access switches
  @Get('documents/access')
  @Doc({ summary: 'Document access switches for company-wide HR and each HR Workspace (Super Workspace)' })
  access() {
    return this.center.accessSettings();
  }

  @Get('documents/access/mine')
  @Doc({ summary: 'What the signed-in person may do with documents' })
  myAccess() {
    return this.center.myAccess();
  }

  @Put('documents/access/:scope')
  @Doc({ summary: 'Change the document access switches of one HR Workspace (or "central" for company-wide HR)', body: documentAccessInput })
  saveAccess(@Param('scope', new ZodPipe(scopeKey)) scope: string, @Body(new ZodPipe(documentAccessInput)) body: z.infer<typeof documentAccessInput>) {
    return this.center.saveAccess(scope, body);
  }

  // Repository
  @Get('documents/center/overview')
  @Doc({ summary: 'Document dashboard numbers within what the person may see' })
  overview() {
    return this.center.overview();
  }

  @Get('documents/center/documents')
  @Doc({ summary: 'Search and filter every document the person may see', query: documentRepositoryQuery })
  repository(@Query(new ZodPipe(documentRepositoryQuery)) q: DocumentRepositoryQuery) {
    return this.center.repository(q);
  }

  @Get('documents/center/export.csv')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="documents.csv"')
  @Doc({ summary: 'The document list as CSV (records only, never files)', query: documentRepositoryQuery })
  export(@Query(new ZodPipe(documentRepositoryQuery)) q: DocumentRepositoryQuery) {
    return this.center.exportCsv(q);
  }

  @Get('documents/center/activity')
  @Doc({ summary: 'Recent document activity', query: activityQuery })
  activity(@Query(new ZodPipe(activityQuery)) q: z.infer<typeof activityQuery>) {
    return this.center.recentActivity(q.limit);
  }

  @Get('documents/center/documents/:id')
  @Doc({ summary: 'One document: details, versions, request and history' })
  document(@Param('id', UuidPipe) id: string) {
    return this.center.document(id);
  }

  @Post('documents/:id/access-link')
  @HttpCode(200)
  @Doc({ summary: 'A 5-minute link to preview or download a file (checked and recorded)', body: linkInput })
  link(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(linkInput)) body: z.infer<typeof linkInput>) {
    return this.center.link(id, body.mode);
  }

  @Get('hr-workspaces/:id/documents')
  @Doc({ summary: "An HR Workspace's own documents and the requests sent to it" })
  hrWorkspace(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(documentRepositoryQuery)) q: DocumentRepositoryQuery) {
    return this.center.hrWorkspaceDocuments(id, q);
  }

  // Requests
  @Get('document-requests/targets')
  @Doc({ summary: 'People and HR Workspaces I may ask for documents' })
  targets() {
    return this.center.targets();
  }

  @Post('document-requests')
  @Doc({ summary: 'Request a document from people or an HR Workspace (each gets a task)', body: documentRequestInput })
  create(@Body(new ZodPipe(documentRequestInput)) body: DocumentRequestInput) {
    return this.center.create(body);
  }

  @Get('document-requests')
  @Doc({ summary: 'Document requests: mine to submit, raised, waiting for my verification, or all I can see', query: documentRequestQuery })
  list(@Query(new ZodPipe(documentRequestQuery)) q: z.infer<typeof documentRequestQuery>) {
    return this.center.listRequests(q);
  }

  @Get('document-requests/:id')
  @Doc({ summary: 'One request with its versions, verification trail and history' })
  get(@Param('id', UuidPipe) id: string) {
    return this.center.getRequest(id);
  }

  @Post('document-requests/:id/opened')
  @HttpCode(200)
  @Doc({ summary: 'The person asked opened the request' })
  opened(@Param('id', UuidPipe) id: string) {
    return this.center.opened(id);
  }

  @Post('document-requests/:id/submit')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 10 }], { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 10 } }))
  @Doc({ summary: 'Submit the requested document (multipart/form-data: file, or files for a document that takes several, remarks, expiresOn). It goes for verification.' })
  submit(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(documentSubmitMeta)) body: z.infer<typeof documentSubmitMeta>, @UploadedFiles() given?: { file?: UploadedFile[]; files?: UploadedFile[] }) {
    return this.center.submit(id, [...(given?.file ?? []), ...(given?.files ?? [])], body);
  }

  @Post('document-requests/:id/review')
  @HttpCode(200)
  @Doc({ summary: 'Start verifying the submission (marks it under verification)' })
  review(@Param('id', UuidPipe) id: string) {
    return this.center.startReview(id);
  }

  @Post('document-requests/:id/decision')
  @HttpCode(200)
  @Doc({ summary: 'Approve, reject (with a reason) or request a correction (with instructions)', body: documentDecisionInput })
  decide(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(documentDecisionInput)) body: z.infer<typeof documentDecisionInput>) {
    return this.center.decide(id, body);
  }

  @Post('document-requests/:id/cancel')
  @HttpCode(200)
  @Doc({ summary: 'Cancel an open request', body: documentCancelInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(documentCancelInput)) body: z.infer<typeof documentCancelInput>) {
    return this.center.cancel(id, body.reason);
  }
}
