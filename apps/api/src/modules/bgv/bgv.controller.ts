import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  bgvAddCheckInput,
  bgvAgencyFindingsInput,
  bgvAgencyInput,
  bgvCancelInput,
  bgvCaseInput,
  bgvCaseUpdateInput,
  bgvCheckUpdateInput,
  bgvDecisionInput,
  bgvFileShareInput,
  bgvListQuery,
  bgvShareInput,
  DOCUMENT_MAX_BYTES,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { sendFile, toXlsx } from '../../platform/export/tabular';
import type { UploadedFile } from '../../platform/storage/uploads';
import { BgvService } from './bgv.service';

const fileMeta = z.object({
  title: z.string().trim().min(1).max(200),
  checkId: z.uuid().optional().or(z.literal('').transform(() => undefined)),
  shared: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
const reportMeta = z.object({ title: z.string().trim().min(1).max(200).default('Verification report') });
const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });
const token = z.string().regex(/^[A-Za-z0-9_-]{40,60}$/);

const upload = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }));

function stream(res: Response, f: { stream: NodeJS.ReadableStream; size: number; fileName: string; contentType: string }) {
  res.setHeader('content-type', f.contentType);
  res.setHeader('content-length', String(f.size));
  res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
  res.setHeader('cache-control', 'private, no-store');
  f.stream.pipe(res);
}

/** Background verification: cases, checks, files, agencies and sharing with an agency. */
@Controller('bgv')
@RequireFeature('background_verification')
export class BgvController {
  constructor(private readonly bgv: BgvService) {}

  @Get('cases')
  @RequirePermission('bgv:view')
  @Doc({ summary: 'Verification cases of the employees I may see', query: bgvListQuery })
  list(@Query(new ZodPipe(bgvListQuery)) q: z.infer<typeof bgvListQuery>) {
    return this.bgv.list(q);
  }

  @Get('cases/export.xlsx')
  @RequirePermission('bgv:export')
  @Doc({ summary: 'Verification cases as an Excel workbook (the same filters as the list)', query: bgvListQuery })
  async export(@Query(new ZodPipe(bgvListQuery)) q: z.infer<typeof bgvListQuery>, @Res() res: Response) {
    sendFile(res, { fileName: `background-verification-${new Date().toISOString().slice(0, 10)}.xlsx`, content: toXlsx('Background verification', await this.bgv.exportRows(q)) }, 'xlsx');
  }

  @Post('cases')
  @RequirePermission('bgv:create')
  @Doc({ summary: 'Start background verification for an employee (internal, or with an agency)', body: bgvCaseInput })
  create(@Body(new ZodPipe(bgvCaseInput)) body: z.infer<typeof bgvCaseInput>) {
    return this.bgv.create(body);
  }

  @Get('cases/:id')
  @RequirePermission('bgv:view')
  @Doc({ summary: 'A case with its checks, files, history and agency links' })
  get(@Param('id', UuidPipe) id: string) {
    return this.bgv.get(id);
  }

  @Patch('cases/:id')
  @RequirePermission('bgv:edit')
  @Doc({ summary: 'Change the due date, verifier, notes or agency reference', body: bgvCaseUpdateInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bgvCaseUpdateInput)) body: z.infer<typeof bgvCaseUpdateInput>) {
    return this.bgv.update(id, body);
  }

  @Post('cases/:id/checks')
  @RequirePermission('bgv:edit')
  @Doc({ summary: 'Add a check to a case', body: bgvAddCheckInput })
  addCheck(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bgvAddCheckInput)) body: z.infer<typeof bgvAddCheckInput>) {
    return this.bgv.addCheck(id, body);
  }

  @Patch('cases/:id/checks/:checkId')
  @RequirePermission('bgv:edit')
  @Doc({ summary: 'Record a check: status, details, linked documents, internal remarks, agency feedback', body: bgvCheckUpdateInput })
  updateCheck(@Param('id', UuidPipe) id: string, @Param('checkId', UuidPipe) checkId: string, @Body(new ZodPipe(bgvCheckUpdateInput)) body: z.infer<typeof bgvCheckUpdateInput>) {
    return this.bgv.updateCheck(id, checkId, body);
  }

  @Post('cases/:id/decision')
  @RequirePermission('bgv:approve')
  @Doc({ summary: 'Set the case result: verified (every check verified), failed, on hold, or back in progress', body: bgvDecisionInput })
  decide(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bgvDecisionInput)) body: z.infer<typeof bgvDecisionInput>) {
    return this.bgv.decide(id, body);
  }

  @Post('cases/:id/cancel')
  @RequirePermission('bgv:delete')
  @Doc({ summary: 'Cancel a case (kept with its history); any agency link stops working', body: bgvCancelInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bgvCancelInput)) body: z.infer<typeof bgvCancelInput>) {
    return this.bgv.cancel(id, body.reason);
  }

  @Post('cases/:id/files')
  @RequirePermission('bgv:edit')
  @upload()
  @Doc({ summary: 'Upload a supporting document (multipart: file, title, checkId, shared). PDF, images, Word or text, up to 10 MB.' })
  uploadFile(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(fileMeta)) meta: z.infer<typeof fileMeta>, @File() file?: UploadedFile) {
    return this.bgv.upload(id, meta, file);
  }

  @Put('files/:fileId/shared')
  @RequirePermission('bgv:edit')
  @Doc({ summary: 'Share a file with the agency, or stop sharing it', body: bgvFileShareInput })
  share(@Param('fileId', UuidPipe) fileId: string, @Body(new ZodPipe(bgvFileShareInput)) body: z.infer<typeof bgvFileShareInput>) {
    return this.bgv.setFileShared(fileId, body.shared);
  }

  @Delete('files/:fileId')
  @RequirePermission('bgv:delete')
  @Doc({ summary: 'Take a file off the case (it stays in the history)' })
  removeFile(@Param('fileId', UuidPipe) fileId: string) {
    return this.bgv.removeFile(fileId);
  }

  @Post('files/:fileId/link')
  @RequirePermission('bgv:view')
  @Doc({ summary: 'A 5-minute download link for a case file (audited)' })
  link(@Param('fileId', UuidPipe) fileId: string) {
    return this.bgv.fileLink(fileId);
  }

  @Post('cases/:id/share')
  @RequirePermission('bgv:edit')
  @Doc({ summary: 'Assign the case to an agency: email it a private link to the shared files and the findings form', body: bgvShareInput })
  sendToAgency(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bgvShareInput)) body: z.infer<typeof bgvShareInput>) {
    return this.bgv.share(id, body);
  }

  @Post('cases/:id/links/:linkId/revoke')
  @RequirePermission('bgv:edit')
  @Doc({ summary: 'Switch an agency link off' })
  revoke(@Param('id', UuidPipe) id: string, @Param('linkId', UuidPipe) linkId: string) {
    return this.bgv.revokeLink(id, linkId);
  }

  @Get('agencies')
  @RequirePermission('bgv:view')
  @Doc({ summary: 'Verification agencies' })
  agencies() {
    return this.bgv.agencies();
  }

  @Post('agencies')
  @RequirePermission('bgv:manage')
  @Doc({ summary: 'Add a verification agency', body: bgvAgencyInput })
  createAgency(@Body(new ZodPipe(bgvAgencyInput)) body: z.infer<typeof bgvAgencyInput>) {
    return this.bgv.createAgency(body);
  }

  @Put('agencies/:id')
  @RequirePermission('bgv:manage')
  @Doc({ summary: 'Change a verification agency (switch it off with active: false)', body: bgvAgencyInput })
  updateAgency(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(bgvAgencyInput)) body: z.infer<typeof bgvAgencyInput>) {
    return this.bgv.updateAgency(id, body);
  }

  @Get('verifiers')
  @RequirePermission('bgv:create')
  @Doc({ summary: 'Members who can be made a case’s verifier (they hold the Edit permission)' })
  verifiers() {
    return this.bgv.verifiers();
  }
}

@Controller()
export class BgvEmployeeController {
  constructor(private readonly bgv: BgvService) {}

  @Get('employees/:id/bgv')
  @RequireFeature('background_verification')
  @RequirePermission('bgv:view')
  @Doc({ summary: "An employee's verification cases" })
  forEmployee(@Param('id', UuidPipe) id: string) {
    return this.bgv.forEmployee(id);
  }

  @Get('files/bgv/:id')
  @Public()
  @Doc({ summary: 'Download a case file through a signed link', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    stream(res, await this.bgv.openFile(id, q.exp, q.sig));
  }
}

/** The agency's side: no account, the private emailed link is the key. Rate limited. */
@Controller('bgv-portal')
@Public()
export class BgvPortalController {
  constructor(private readonly bgv: BgvService) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Doc({ summary: 'An agency reads a verification request: the checks and the files shared with it' })
  get(@Param('token', new ZodPipe(token)) t: string) {
    return this.bgv.portal(t);
  }

  @Get(':token/files/:fileId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Doc({ summary: 'An agency downloads a shared file (audited)' })
  async file(@Param('token', new ZodPipe(token)) t: string, @Param('fileId', UuidPipe) fileId: string, @Res() res: Response) {
    stream(res, await this.bgv.portalFile(t, fileId));
  }

  @Post(':token/findings')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Doc({ summary: 'An agency sends its findings per check and the completion date', body: bgvAgencyFindingsInput })
  findings(@Param('token', new ZodPipe(token)) t: string, @Body(new ZodPipe(bgvAgencyFindingsInput)) body: z.infer<typeof bgvAgencyFindingsInput>) {
    return this.bgv.portalFindings(t, body);
  }

  @Post(':token/report')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @upload()
  @Doc({ summary: 'An agency uploads its report (multipart: file, title)' })
  report(@Param('token', new ZodPipe(token)) t: string, @Body(new ZodPipe(reportMeta)) meta: z.infer<typeof reportMeta>, @File() file?: UploadedFile) {
    return this.bgv.portalReport(t, meta.title, file);
  }
}
