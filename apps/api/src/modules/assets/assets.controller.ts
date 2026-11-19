import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ASSET_REPORTS,
  assetAcknowledgeInput,
  assetAssignInput,
  assetCategoryInput,
  assetCategoryUpdate,
  assetInput,
  assetListQuery,
  assetReportQuery,
  assetReturnInput,
  assetStatusInput,
  assetUpdate,
  DOCUMENT_MAX_BYTES,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { renderTablePdf } from '../../platform/export/table-pdf';
import { sendFile, toXlsx } from '../../platform/export/tabular';
import type { UploadedFile } from '../../platform/storage/uploads';
import { AssetsService } from './assets.service';

const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });
const fileMeta = z.object({ title: z.string().trim().min(1).max(200) });
const reportParams = z.object({ kind: z.enum(ASSET_REPORTS), format: z.enum(['xlsx', 'pdf']) });

/** Company assets: inventory, categories, assignment, acknowledgement, returns, maintenance and reports. */
@Controller('assets')
@RequireFeature('asset_management')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermission('assets:view')
  @Doc({ summary: 'Assets I may see (the whole inventory, or what people in my scope hold), with counts by status', query: assetListQuery })
  list(@Query(new ZodPipe(assetListQuery)) q: z.infer<typeof assetListQuery>) {
    return this.assets.list(q);
  }

  @Get('mine')
  @RequirePermission('assets:view')
  @Doc({ summary: 'Assets I hold or held, and which still need my acknowledgement' })
  mine() {
    return this.assets.mine();
  }

  @Post('assignments/:id/acknowledge')
  @RequirePermission('assets:view')
  @Doc({ summary: 'Acknowledge an asset assigned to me: my typed name and acceptance are kept as the digital record', body: assetAcknowledgeInput })
  acknowledge(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assetAcknowledgeInput)) body: z.infer<typeof assetAcknowledgeInput>, @Req() req: Request) {
    return this.assets.acknowledge(id, body, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
  }

  @Get('categories')
  @RequirePermission('assets:view')
  @Doc({ summary: 'Asset categories (the defaults are added on first use)' })
  categories() {
    return this.assets.categories();
  }

  @Post('categories')
  @RequirePermission('assets:manage')
  @Doc({ summary: 'Add an asset category', body: assetCategoryInput })
  createCategory(@Body(new ZodPipe(assetCategoryInput)) body: z.infer<typeof assetCategoryInput>) {
    return this.assets.createCategory(body);
  }

  @Patch('categories/:id')
  @RequirePermission('assets:manage')
  @Doc({ summary: 'Rename, recode or archive a category', body: assetCategoryUpdate })
  updateCategory(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assetCategoryUpdate)) body: z.infer<typeof assetCategoryUpdate>) {
    return this.assets.updateCategory(id, body);
  }

  @Get('reports/:kind.:format')
  @RequirePermission('assets:export')
  @Doc({ summary: 'An asset report as Excel or PDF: employee, department, available, assigned, returned, damaged_lost, purchases, maintenance', query: assetReportQuery })
  async report(@Param(new ZodPipe(reportParams)) p: z.infer<typeof reportParams>, @Query(new ZodPipe(assetReportQuery)) q: z.infer<typeof assetReportQuery>, @Res() res: Response) {
    const r = await this.assets.report(p.kind, q);
    const name = `assets-${p.kind.replace(/_/g, '-')}-${new Date().toISOString().slice(0, 10)}`;
    if (p.format === 'xlsx') return sendFile(res, { fileName: `${name}.xlsx`, content: toXlsx(r.title, r.rows) }, 'xlsx');
    const pdf = await renderTablePdf(r.title, r.subtitle, r.rows);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', contentDisposition('attachment', `${name}.pdf`));
    res.setHeader('cache-control', 'private, no-store');
    res.send(pdf);
  }

  @Post()
  @RequirePermission('assets:create')
  @Doc({ summary: 'Register an asset (the asset ID is numbered in its category when left out)', body: assetInput })
  create(@Body(new ZodPipe(assetInput)) body: z.infer<typeof assetInput>) {
    return this.assets.create(body);
  }

  @Get(':id')
  @RequirePermission('assets:view')
  @Doc({ summary: 'An asset with its assignments, acknowledgements, history and files' })
  get(@Param('id', UuidPipe) id: string) {
    return this.assets.get(id);
  }

  @Patch(':id')
  @RequirePermission('assets:edit')
  @Doc({ summary: 'Change an asset’s details', body: assetUpdate })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assetUpdate)) body: z.infer<typeof assetUpdate>) {
    return this.assets.update(id, body);
  }

  @Delete(':id')
  @RequirePermission('assets:delete')
  @HttpCode(204)
  @Doc({ summary: 'Delete an asset that was never assigned (others are retired instead)' })
  async remove(@Param('id', UuidPipe) id: string) {
    await this.assets.remove(id);
  }

  @Post(':id/assign')
  @RequirePermission('assets:create')
  @Doc({ summary: 'Assign an available asset to an employee, who is asked to acknowledge it', body: assetAssignInput })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assetAssignInput)) body: z.infer<typeof assetAssignInput>) {
    return this.assets.assign(id, body);
  }

  @Post(':id/return')
  @RequirePermission('assets:edit')
  @Doc({ summary: 'Record the return of an assigned asset and its condition', body: assetReturnInput })
  returnAsset(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assetReturnInput)) body: z.infer<typeof assetReturnInput>) {
    return this.assets.returnAsset(id, body);
  }

  @Post(':id/status')
  @RequirePermission('assets:view')
  @Doc({ summary: 'Maintenance, back in service, damaged, lost (needs Approve) or retired (needs Delete)', body: assetStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assetStatusInput)) body: z.infer<typeof assetStatusInput>) {
    return this.assets.setStatus(id, body);
  }

  @Post(':id/files')
  @RequirePermission('assets:edit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Attach a document (invoice, warranty, photo). Multipart: file, title.' })
  upload(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(fileMeta)) meta: z.infer<typeof fileMeta>, @File() file?: UploadedFile) {
    return this.assets.upload(id, meta.title, file);
  }

  @Delete('files/:fileId')
  @RequirePermission('assets:edit')
  @Doc({ summary: 'Remove a document from an asset (kept in storage)' })
  removeFile(@Param('fileId', UuidPipe) fileId: string) {
    return this.assets.removeFile(fileId);
  }

  @Post('files/:fileId/link')
  @RequirePermission('assets:view')
  @Doc({ summary: 'A 5-minute download link for an asset document' })
  link(@Param('fileId', UuidPipe) fileId: string) {
    return this.assets.fileLink(fileId);
  }
}

@Controller()
export class AssetsEmployeeController {
  constructor(private readonly assets: AssetsService) {}

  @Get('employees/:id/assets')
  @RequireFeature('asset_management')
  @RequirePermission('assets:view')
  @Doc({ summary: 'Assets an employee holds and held' })
  forEmployee(@Param('id', UuidPipe) id: string) {
    return this.assets.forEmployee(id);
  }

  @Get('files/assets/:id')
  @Public()
  @Doc({ summary: 'Download an asset document through a signed link', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    const f = await this.assets.openFile(id, q.exp, q.sig);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-length', String(f.size));
    res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
    res.setHeader('cache-control', 'private, no-store');
    f.stream.pipe(res);
  }
}
