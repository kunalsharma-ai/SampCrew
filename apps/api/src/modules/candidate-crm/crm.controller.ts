import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  crmAccessInput, type CrmAccessInput, crmActivityInput, type CrmActivityInput, crmActivityQuery, type CrmActivityQuery, crmAssignInput, crmBulkInput, type CrmBulkInput,
  crmCandidateInput, type CrmCandidateInput, crmCandidatePatch, type CrmCandidatePatch, CRM_DOCUMENT_MAX_BYTES, CRM_PHOTO_MAX_BYTES, crmDocumentMeta, crmExportInput, type CrmExportInput,
  crmFieldInput, type CrmFieldInput, crmFieldsOrder, crmFieldUpdate, crmFollowUpQuery, type CrmFollowUpQuery, crmImportPlanInput, type CrmImportPlanInput, crmListQuery, crmNoteInput,
  crmSettingsInput, type CrmSettingsInput, crmShareInput, crmStageInput, followUpInput, type FollowUpInput, followUpUpdate, referenceInput, type ReferenceInput, referencePatch,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { CrmAccessService } from './crm-access.service';
import { CrmFieldsService } from './crm-fields.service';
import { CrmImportService } from './crm-import.service';
import { CrmWorkService } from './crm-work.service';
import { CrmService } from './crm.service';

const reasonInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const archiveInput = z.object({ archived: z.boolean() }).strict();
const fieldArchiveInput = z.object({ archived: z.boolean() }).strict();
const uploadQuery = z.object({ hrWorkspaceId: z.union([z.uuid(), z.literal('')]).optional().transform((v) => (v === '' ? null : v)) });
const docQuery = z.object({ inline: z.enum(['0', '1']).optional() });
const replaceBody = z.object({ notes: z.string().trim().max(1000).optional() });
/** The list query as the pages send it (custom field filters as cf.<key>=value). */
const listQuery = z.record(z.string(), z.string());
const INLINE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain']);

function toListQuery(raw: Record<string, string>) {
  const cf: Record<string, string> = {};
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (k.startsWith('cf.')) cf[k.slice(3)] = v; else rest[k] = v;
  const parsed = crmListQuery.safeParse({ ...rest, ...(Object.keys(cf).length ? { cf } : {}) });
  if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return parsed.data;
}

function stream(res: Response, f: { stream: NodeJS.ReadableStream; size: number; contentType: string; fileName?: string }, inline: boolean) {
  res.setHeader('content-type', f.contentType);
  res.setHeader('content-length', String(f.size));
  res.setHeader('content-disposition', contentDisposition(inline && INLINE.has(f.contentType) ? 'inline' : 'attachment', f.fileName ?? 'file'));
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  f.stream.pipe(res);
}

function sendDownload(res: Response, f: { fileName: string; content: string | Buffer }) {
  const xlsx = f.fileName.endsWith('.xlsx');
  res.setHeader('content-type', xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
  res.setHeader('cache-control', 'private, no-store');
  res.send(f.content);
}

/**
 * Recruitment & ATS > Candidate CRM. Every route checks the person's CRM access in the service: Super Workspace
 * always, an HR Workspace only while Super Workspace has the CRM switched on for it, Employee Workspace never.
 */
@Controller('recruitment/crm')
@RequireFeature('recruitment')
export class CandidateCrmController {
  constructor(
    private readonly access: CrmAccessService,
    private readonly crm: CrmService,
    private readonly work: CrmWorkService,
    private readonly fields: CrmFieldsService,
    private readonly imports: CrmImportService,
  ) {}

  // Access ------------------------------------------------------------------------------------------------------

  @Get('context')
  @Doc({ summary: 'Your Candidate CRM access: level, HR Workspaces and powers, pipeline stages, sources and recruiters' })
  context() {
    return this.access.context();
  }

  @Get('access')
  @Doc({ summary: 'Super Workspace: Candidate CRM access for each HR Workspace and the company-wide HR team' })
  accessList() {
    return this.access.accessList();
  }

  @Put('access')
  @Doc({ summary: 'Super Workspace: switch Candidate CRM on or off for HR Workspaces and choose their powers (data is kept when switched off)', body: crmAccessInput })
  setAccess(@Body(new ZodPipe(crmAccessInput)) body: CrmAccessInput) {
    return this.access.setAccess(body);
  }

  // Overview, list, pipeline -------------------------------------------------------------------------------------

  @Get('overview')
  @Doc({ summary: 'Candidate CRM dashboard: totals, stages, sources, follow-ups, weekly trend and recruiter-wise view' })
  overview() {
    return this.crm.overview();
  }

  @Get('candidates')
  @Doc({ summary: 'Candidates you can see, filtered and sorted (custom field filters as cf.<key>=value)', query: crmListQuery })
  list(@Query(new ZodPipe(listQuery)) q: Record<string, string>) {
    return this.crm.list(toListQuery(q));
  }

  @Get('pipeline')
  @Doc({ summary: 'The recruitment pipeline: each stage with its candidates', query: crmListQuery })
  pipeline(@Query(new ZodPipe(listQuery)) q: Record<string, string>) {
    return this.crm.pipeline(toListQuery(q));
  }

  @Post('candidates')
  @Doc({ summary: 'Add a candidate: gets the next candidate ID (CAN-000124) and starts in New Candidate', body: crmCandidateInput })
  create(@Body(new ZodPipe(crmCandidateInput)) body: CrmCandidateInput) {
    return this.crm.create(body);
  }

  @Post('candidates/bulk')
  @HttpCode(200)
  @Doc({ summary: 'Move, assign, tag or archive up to 200 candidates; each is checked on its own', body: crmBulkInput })
  bulk(@Body(new ZodPipe(crmBulkInput)) body: CrmBulkInput) {
    return this.crm.bulk(body);
  }

  @Get('candidates/:id')
  @Doc({ summary: 'The 360° candidate profile: details, remarks, references, documents, follow-ups, activities, jobs and custom fields' })
  get(@Param('id', UuidPipe) id: string) {
    return this.crm.get(id);
  }

  @Patch('candidates/:id')
  @Doc({ summary: 'Change a candidate (sections are replaced as a whole)', body: crmCandidatePatch })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmCandidatePatch)) body: CrmCandidatePatch) {
    return this.crm.update(id, body);
  }

  @Post('candidates/:id/stage')
  @HttpCode(200)
  @Doc({ summary: 'Move a candidate to another pipeline stage, with an optional remark', body: crmStageInput })
  stage(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmStageInput)) body: z.infer<typeof crmStageInput>) {
    return this.crm.setStage(id, body.stage, body.note);
  }

  @Post('candidates/:id/assign')
  @HttpCode(200)
  @Doc({ summary: 'Assign the candidate to a recruiter (or no one); they are notified', body: crmAssignInput })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmAssignInput)) body: z.infer<typeof crmAssignInput>) {
    return this.crm.assign(id, body.membershipId);
  }

  @Put('candidates/:id/share')
  @Doc({ summary: 'Super Workspace: share the record with other HR Workspaces', body: crmShareInput })
  share(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmShareInput)) body: z.infer<typeof crmShareInput>) {
    return this.crm.share(id, body.hrWorkspaceIds);
  }

  @Post('candidates/:id/archive')
  @HttpCode(200)
  @Doc({ summary: 'Archive or restore a candidate (needs the archive and delete power)', body: archiveInput })
  archive(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(archiveInput)) body: z.infer<typeof archiveInput>) {
    return this.crm.archive(id, body.archived);
  }

  @Post('candidates/:id/erase')
  @HttpCode(200)
  @Doc({ summary: 'Erase the candidate’s personal data (for example on their request). Cannot be undone.', body: reasonInput })
  erase(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reasonInput)) body: z.infer<typeof reasonInput>) {
    return this.crm.erase(id, body.reason);
  }

  @Get('candidates/:id/photo')
  @Doc({ summary: 'The candidate’s photo' })
  async photo(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    const f = await this.crm.openPhoto(id);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-length', String(f.size));
    res.setHeader('cache-control', 'private, max-age=300');
    res.setHeader('x-content-type-options', 'nosniff');
    f.stream.pipe(res);
  }

  @Put('candidates/:id/photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CRM_PHOTO_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Set the candidate’s photo (multipart/form-data: file). JPEG, PNG or WebP up to 3 MB.' })
  setPhoto(@Param('id', UuidPipe) id: string, @File() file?: UploadedFile) {
    return this.crm.setPhoto(id, file);
  }

  @Delete('candidates/:id/photo')
  @Doc({ summary: 'Remove the candidate’s photo' })
  removePhoto(@Param('id', UuidPipe) id: string) {
    return this.crm.removePhoto(id);
  }

  // Remarks, references, activities, follow-ups ----------------------------------------------------------------

  @Post('candidates/:id/remarks')
  @Doc({ summary: 'Add a dated recruiter remark (earlier remarks are kept)', body: crmNoteInput })
  remark(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmNoteInput)) body: z.infer<typeof crmNoteInput>) {
    return this.work.addRemark(id, body);
  }

  @Post('candidates/:id/references')
  @Doc({ summary: 'Add a reference (who referred or vouches for the candidate)', body: referenceInput })
  addReference(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(referenceInput)) body: ReferenceInput) {
    return this.work.addReference(id, body);
  }

  @Patch('references/:id')
  @Doc({ summary: 'Change a reference', body: referencePatch })
  updateReference(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(referencePatch)) body: z.infer<typeof referencePatch>) {
    return this.work.updateReference(id, body);
  }

  @Delete('references/:id')
  @Doc({ summary: 'Remove a reference' })
  removeReference(@Param('id', UuidPipe) id: string) {
    return this.work.removeReference(id);
  }

  @Post('candidates/:id/activities')
  @Doc({ summary: 'Log a call (with its outcome), email, message, meeting or interview; optionally schedule the next follow-up', body: crmActivityInput })
  logActivity(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmActivityInput)) body: CrmActivityInput) {
    return this.work.logActivity(id, body);
  }

  @Get('activities')
  @Doc({ summary: 'Logged activities across your candidates, with call outcomes', query: crmActivityQuery })
  activities(@Query(new ZodPipe(crmActivityQuery)) q: CrmActivityQuery) {
    return this.work.activities(q);
  }

  @Post('candidates/:id/follow-ups')
  @Doc({ summary: 'Schedule a follow-up with a reminder', body: followUpInput })
  addFollowUp(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(followUpInput)) body: FollowUpInput) {
    return this.work.addFollowUp(id, body);
  }

  @Patch('follow-ups/:id')
  @Doc({ summary: 'Complete, reschedule, cancel or mark a follow-up missed, or change it', body: followUpUpdate })
  updateFollowUp(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(followUpUpdate)) body: z.infer<typeof followUpUpdate>) {
    return this.work.updateFollowUp(id, body);
  }

  @Get('follow-ups')
  @Doc({ summary: 'Follow-ups across your candidates: overdue, today, upcoming, completed and missed', query: crmFollowUpQuery })
  followUps(@Query(new ZodPipe(crmFollowUpQuery)) q: CrmFollowUpQuery) {
    return this.work.followUps(q);
  }

  // Documents ----------------------------------------------------------------------------------------------------

  @Post('candidates/:id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CRM_DOCUMENT_MAX_BYTES, files: 1, fields: 5, fieldSize: 2000 } }))
  @Doc({ summary: 'Upload a document (multipart/form-data: file, kind, name, notes). PDF, DOC, DOCX, JPEG, PNG, WebP or text up to 10 MB.', body: crmDocumentMeta })
  upload(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmDocumentMeta)) body: z.infer<typeof crmDocumentMeta>, @File() file?: UploadedFile) {
    return this.work.uploadDocument(id, file, body);
  }

  @Post('documents/:id/replace')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CRM_DOCUMENT_MAX_BYTES, files: 1, fields: 2, fieldSize: 2000 } }))
  @Doc({ summary: 'Upload a new version of a document (the earlier version is kept)', body: replaceBody })
  replace(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(replaceBody)) body: z.infer<typeof replaceBody>, @File() file?: UploadedFile) {
    return this.work.replaceDocument(id, file, body.notes);
  }

  @Delete('documents/:id')
  @Doc({ summary: 'Delete a document and its earlier versions (needs the archive and delete power)' })
  deleteDocument(@Param('id', UuidPipe) id: string) {
    return this.work.deleteDocument(id);
  }

  @Get('documents/:id')
  @Doc({ summary: 'Download a document, or view it (inline=1) for PDFs, images and text. Audited.', query: docQuery })
  async document(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(docQuery)) q: z.infer<typeof docQuery>, @Res() res: Response) {
    stream(res, await this.work.openDocument(id), q.inline === '1');
  }

  // Export -------------------------------------------------------------------------------------------------------

  @Get('export/columns')
  @Doc({ summary: 'Columns you may export and the recent export log' })
  exportColumns() {
    return this.crm.exportColumns();
  }

  @Post('export')
  @HttpCode(200)
  @Doc({ summary: 'Export candidates (all, filtered or selected) with the chosen columns, as Excel or CSV. Logged.', body: crmExportInput })
  async export(@Body(new ZodPipe(crmExportInput)) body: CrmExportInput, @Res() res: Response) {
    sendDownload(res, await this.crm.export(body));
  }

  // Custom fields ------------------------------------------------------------------------------------------------

  @Get('fields')
  @Doc({ summary: 'Candidate custom fields you can see, with where each appears' })
  fieldList() {
    return this.fields.list();
  }

  @Post('fields')
  @Doc({ summary: 'Create a custom field (Super Workspace, or an HR Workspace given the power)', body: crmFieldInput })
  createField(@Body(new ZodPipe(crmFieldInput)) body: CrmFieldInput) {
    return this.fields.create(body);
  }

  @Patch('fields/:id')
  @Doc({ summary: 'Change a custom field', body: crmFieldUpdate })
  updateField(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmFieldUpdate)) body: z.infer<typeof crmFieldUpdate>) {
    return this.fields.update(id, body);
  }

  @Post('fields/:id/archive')
  @HttpCode(200)
  @Doc({ summary: 'Archive or restore a custom field (values are kept)', body: fieldArchiveInput })
  archiveField(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(fieldArchiveInput)) body: z.infer<typeof fieldArchiveInput>) {
    return this.fields.archive(id, body.archived);
  }

  @Put('fields/order')
  @Doc({ summary: 'Set the order of custom fields', body: crmFieldsOrder })
  orderFields(@Body(new ZodPipe(crmFieldsOrder)) body: z.infer<typeof crmFieldsOrder>) {
    return this.fields.reorder(body.ids);
  }

  // Settings -----------------------------------------------------------------------------------------------------

  @Get('settings')
  @Doc({ summary: 'Candidate CRM settings: pipeline stages, sources, retention and duplicate rules' })
  settings() {
    return this.crm.settings();
  }

  @Put('settings')
  @Doc({ summary: 'Super Workspace: change the pipeline stages, sources, retention and duplicate rules', body: crmSettingsInput })
  saveSettings(@Body(new ZodPipe(crmSettingsInput)) body: CrmSettingsInput) {
    return this.crm.saveSettings(body);
  }

  // Import -------------------------------------------------------------------------------------------------------

  @Get('imports')
  @Doc({ summary: 'Import history' })
  importHistory() {
    return this.imports.history();
  }

  @Get('import-template.xlsx')
  @Doc({ summary: 'A blank import workbook with the usual columns and an example row' })
  async importTemplate(@Res() res: Response) {
    sendDownload(res, await this.imports.sampleFile());
  }

  @Post('imports')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024, files: 1 } }))
  @Doc({ summary: 'Upload an Excel or CSV file to import (multipart/form-data: file). Returns its columns and a suggested mapping.', query: uploadQuery })
  uploadImport(@Query(new ZodPipe(uploadQuery)) q: z.infer<typeof uploadQuery>, @File() file?: UploadedFile) {
    return this.imports.upload(file, q.hrWorkspaceId);
  }

  @Get('imports/:id')
  @Doc({ summary: 'One import: its columns, mapping and results' })
  getImport(@Param('id', UuidPipe) id: string) {
    return this.imports.get(id);
  }

  @Post('imports/:id/check')
  @HttpCode(200)
  @Doc({ summary: 'Check every row with the mapping (nothing is imported): problems, duplicates and a preview', body: crmImportPlanInput })
  checkImport(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmImportPlanInput)) body: CrmImportPlanInput) {
    return this.imports.check(id, body);
  }

  @Post('imports/:id/run')
  @HttpCode(200)
  @Doc({ summary: 'Import the rows (duplicates skipped, updated or created as chosen)', body: crmImportPlanInput })
  runImport(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(crmImportPlanInput)) body: CrmImportPlanInput) {
    return this.imports.run(id, body);
  }

  @Post('imports/:id/cancel')
  @HttpCode(200)
  @Doc({ summary: 'Cancel an import that has not run' })
  cancelImport(@Param('id', UuidPipe) id: string) {
    return this.imports.cancel(id);
  }

  @Get('imports/:id/problems.xlsx')
  @Doc({ summary: 'The rows that did not go in, with what is wrong, as Excel' })
  async importProblems(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    sendDownload(res, await this.imports.errorReport(id));
  }

  @Delete('import-templates/:id')
  @Doc({ summary: 'Delete a saved column mapping' })
  deleteTemplate(@Param('id', UuidPipe) id: string) {
    return this.imports.deleteTemplate(id);
  }
}
