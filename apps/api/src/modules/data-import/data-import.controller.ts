import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { employeeBulkInput, type EmployeeBulkInput, IMPORT_MAX_FILE_BYTES, IMPORT_TYPES, importDecisionsInput, importHistoryQuery, importMappingInput, type ImportMappingInput, importRowsQuery, importStartQuery, VALUE_LISTS } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { sendFile } from '../../platform/export/tabular';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../../platform/storage/uploads';
import { DataImportService } from './data-import.service';
import { EmployeeBulkService } from './employee-bulk.service';

const templateQuery = z.object({ list: z.enum(VALUE_LISTS).optional() });
const TypePipe = new ZodPipe(z.enum(IMPORT_TYPES));

/**
 * Data import: Upload > Map columns > Check > Decide duplicates > Import > Report. Super Workspace and HR Workspace
 * people with imports:run (switched per HR Workspace by the Super Workspace); never the Employee Workspace.
 */
@Controller('imports')
@RequireFeature('data_import')
export class DataImportController {
  constructor(private readonly imports: DataImportService) {}

  @Get()
  @Doc({ summary: 'Import history: imports you started, or all of them for the Super Workspace', query: importHistoryQuery })
  history(@Query(new ZodPipe(importHistoryQuery)) q: z.infer<typeof importHistoryQuery>) {
    return this.imports.history(q);
  }

  @Get('types')
  @Doc({ summary: 'What can be imported, and whether you may import each' })
  types() {
    return this.imports.types();
  }

  @Get('templates/:type')
  @RequirePermission('imports:run')
  @Doc({ summary: 'A template for a kind of record (Excel, with an instructions sheet)', query: templateQuery })
  async template(@Param('type', TypePipe) type: (typeof IMPORT_TYPES)[number], @Query(new ZodPipe(templateQuery)) q: z.infer<typeof templateQuery>, @Res() res: Response) {
    const f = await this.imports.template(type, q.list);
    sendFile(res, f, 'xlsx');
  }

  @Post()
  @RequirePermission('imports:run')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a file (Excel .xlsx or CSV) to start an import. Multipart: file.', query: importStartQuery })
  start(@Query(new ZodPipe(importStartQuery)) q: z.infer<typeof importStartQuery>, @File() file?: UploadedFile) {
    return this.imports.start(q.type, q.list, file);
  }

  @Get(':id')
  @Doc({ summary: 'An import: its columns, mapping, suggestions, the fields it can fill, counts and progress' })
  get(@Param('id', UuidPipe) id: string) {
    return this.imports.get(id);
  }

  @Put(':id/mapping')
  @RequirePermission('imports:run')
  @Doc({ summary: 'Map columns to fields (creating custom fields for new columns), choose how duplicates are handled, then check every row', body: importMappingInput })
  mapping(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(importMappingInput)) body: ImportMappingInput) {
    return this.imports.saveMapping(id, body);
  }

  @Get(':id/columns/:column/guess')
  @Doc({ summary: 'A suggested field type and options for a column, from its values' })
  guess(@Param('id', UuidPipe) id: string, @Param('column', ParseIntPipe) column: number) {
    return this.imports.columnGuess(id, column);
  }

  @Post(':id/validate')
  @RequirePermission('imports:run')
  @Doc({ summary: 'Check every row again against SampCrew as it is now' })
  validate(@Param('id', UuidPipe) id: string) {
    return this.imports.validate(id);
  }

  @Get(':id/rows')
  @Doc({ summary: 'The rows with what the check found and what the import did', query: importRowsQuery })
  rows(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(importRowsQuery)) q: z.infer<typeof importRowsQuery>) {
    return this.imports.rows(id, q);
  }

  @Put(':id/decisions')
  @RequirePermission('imports:run')
  @Doc({ summary: 'For rows matching an existing record: skip, update it, or create a new record', body: importDecisionsInput })
  decide(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(importDecisionsInput)) body: z.infer<typeof importDecisionsInput>) {
    return this.imports.decide(id, body.decisions);
  }

  @Post(':id/run')
  @RequirePermission('imports:run')
  @Doc({ summary: 'Import the checked rows (or carry on with a stopped import). Runs in the background.' })
  run(@Param('id', UuidPipe) id: string) {
    return this.imports.run(id);
  }

  @Post(':id/cancel')
  @RequirePermission('imports:run')
  @Doc({ summary: 'Cancel an import (rows already imported are kept, each complete)' })
  cancel(@Param('id', UuidPipe) id: string) {
    return this.imports.cancel(id);
  }

  @Get(':id/report.xlsx')
  @Doc({ summary: 'The report: summary, every problem with a suggested correction, the rows to fix and all rows' })
  async report(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    sendFile(res, await this.imports.report(id), 'xlsx');
  }
}

/** Several employees changed at once from the Employees list (each one checked as if changed alone). */
@Controller('employees/bulk')
export class EmployeeBulkController {
  constructor(private readonly bulk: EmployeeBulkService) {}

  @Post()
  @RequirePermission('employees:update')
  @Doc({ summary: 'Change several employees at once: department, job title, location, manager (dated job changes) or a custom field', body: employeeBulkInput })
  apply(@Body(new ZodPipe(employeeBulkInput)) body: EmployeeBulkInput) {
    return this.bulk.apply(body);
  }
}
