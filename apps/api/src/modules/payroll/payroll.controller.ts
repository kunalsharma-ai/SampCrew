import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  adjustmentInput,
  componentInput,
  type ComponentInput,
  EXPENSE_STATUSES,
  expenseCategoryInput,
  expenseClaimInput,
  itemOverrideInput,
  PAYROLL_RUN_STATUSES,
  payrollRunInput,
  RECEIPT_MAX_BYTES,
  salaryInput,
  type SalaryInput,
  statutoryInput,
  type StatutoryInput,
  structureInput,
  type StructureInput,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { ExpensesService } from './expenses.service';
import { PayrollConfigService } from './payroll-config.service';
import { PayrollRunsService } from './payroll-runs.service';
import { PayslipsService } from './payslips.service';
import { SalariesService } from './salaries.service';

const entityQuery = z.object({ legalEntityId: z.uuid().optional() });
const salaryQuery = z.object({ legalEntityId: z.uuid().optional(), q: z.string().trim().max(120).optional() });
const runQuery = z.object({ legalEntityId: z.uuid().optional(), status: z.enum(PAYROLL_RUN_STATUSES).optional() });
const reasonInput = z.object({ reason: z.string().trim().min(3).max(500) });
const payslipQuery = z.object({ employeeId: z.uuid().optional(), mine: z.enum(['true', 'false']).optional() });
const claimQuery = z.object({ view: z.enum(['mine', 'approvals', 'all']).default('mine'), status: z.enum(EXPENSE_STATUSES).optional() });
const categoryQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });
const fileQuery = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(200) });

function sendCsv(res: Response, f: { fileName: string; content: string }) {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${f.fileName}"`);
  res.setHeader('cache-control', 'private, no-store');
  res.send(f.content);
}

@Controller('payroll')
@RequireFeature('payroll')
export class PayrollController {
  constructor(
    private readonly config: PayrollConfigService,
    private readonly salaries: SalariesService,
    private readonly runs: PayrollRunsService,
  ) {}

  // Settings ----------------------------------------------------------------------------------------------

  @Get('components')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'Pay components (earnings and deductions)' })
  components() {
    return this.config.listComponents();
  }

  @Post('components')
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Add a pay component', body: componentInput })
  createComponent(@Body(new ZodPipe(componentInput)) body: ComponentInput) {
    return this.config.createComponent(body);
  }

  @Put('components/:id')
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Change a pay component (its code and kind are fixed)', body: componentInput })
  updateComponent(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(componentInput)) body: ComponentInput) {
    return this.config.updateComponent(id, body);
  }

  @Delete('components/:id')
  @HttpCode(204)
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Archive a pay component no active structure uses' })
  archiveComponent(@Param('id', UuidPipe) id: string) {
    return this.config.archiveComponent(id);
  }

  @Get('structures')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'Salary structures with their lines' })
  structures() {
    return this.config.listStructures();
  }

  @Post('structures')
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Create a salary structure', body: structureInput })
  createStructure(@Body(new ZodPipe(structureInput)) body: StructureInput) {
    return this.config.createStructure(body);
  }

  @Put('structures/:id')
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Change a salary structure (salaries already assigned keep their breakdown)', body: structureInput })
  updateStructure(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(structureInput)) body: StructureInput) {
    return this.config.updateStructure(id, body);
  }

  @Delete('structures/:id')
  @HttpCode(204)
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Archive a salary structure' })
  archiveStructure(@Param('id', UuidPipe) id: string) {
    return this.config.archiveStructure(id);
  }

  @Get('statutory')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'Saved statutory settings per legal entity, and the India starting values to review', query: entityQuery })
  statutory(@Query(new ZodPipe(entityQuery)) q: z.infer<typeof entityQuery>) {
    return this.config.statutory(q.legalEntityId);
  }

  @Post('statutory')
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Save statutory settings for a legal entity from a date', body: statutoryInput })
  saveStatutory(@Body(new ZodPipe(statutoryInput)) body: StatutoryInput) {
    return this.config.saveStatutory(body);
  }

  @Delete('statutory/:id')
  @HttpCode(204)
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Remove statutory settings that no payroll run has used' })
  removeStatutory(@Param('id', UuidPipe) id: string) {
    return this.config.removeStatutory(id);
  }

  // Salaries ----------------------------------------------------------------------------------------------

  @Get('salaries')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'Employees with their current salary', query: salaryQuery })
  listSalaries(@Query(new ZodPipe(salaryQuery)) q: z.infer<typeof salaryQuery>) {
    return this.salaries.list(q);
  }

  @Get('salaries/:employeeId')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'An employee’s salary revisions with their monthly breakdown' })
  salaryHistory(@Param('employeeId', UuidPipe) id: string) {
    return this.salaries.history(id);
  }

  @Post('salaries/:employeeId/preview')
  @HttpCode(200)
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Preview how a CTC splits into components with a structure', body: salaryInput })
  previewSalary(@Param('employeeId', UuidPipe) id: string, @Body(new ZodPipe(salaryInput)) body: SalaryInput) {
    return this.salaries.preview(id, body);
  }

  @Post('salaries/:employeeId')
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Assign a salary from a date (a new revision)', body: salaryInput })
  assignSalary(@Param('employeeId', UuidPipe) id: string, @Body(new ZodPipe(salaryInput)) body: SalaryInput) {
    return this.salaries.assign(id, body);
  }

  @Delete('salary-revisions/:id')
  @HttpCode(204)
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Remove a salary revision that payroll has not used' })
  removeSalary(@Param('id', UuidPipe) id: string) {
    return this.salaries.remove(id);
  }

  // Runs --------------------------------------------------------------------------------------------------

  @Get('runs')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'Payroll runs you can see', query: runQuery })
  listRuns(@Query(new ZodPipe(runQuery)) q: z.infer<typeof runQuery>) {
    return this.runs.list(q);
  }

  @Post('runs')
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Start a payroll run for a legal entity and month', body: payrollRunInput })
  createRun(@Body(new ZodPipe(payrollRunInput)) body: z.infer<typeof payrollRunInput>) {
    return this.runs.create(body);
  }

  @Get('runs/:id')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'A payroll run with its items, adjustments, warnings and what you can do next' })
  getRun(@Param('id', UuidPipe) id: string) {
    return this.runs.get(id);
  }

  @Get('runs/:id/employees')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'Employees of the run’s legal entity (for adjustments)' })
  runEmployees(@Param('id', UuidPipe) id: string) {
    return this.runs.employeesForRun(id);
  }

  @Post('runs/:id/compute')
  @HttpCode(200)
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Compute (or recompute) every payslip in the run' })
  compute(@Param('id', UuidPipe) id: string) {
    return this.runs.compute(id);
  }

  @Get('runs/:id/items/:itemId')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'One employee’s computed pay with the explanation of every line' })
  item(@Param('id', UuidPipe) id: string, @Param('itemId', UuidPipe) itemId: string) {
    return this.runs.item(id, itemId);
  }

  @Patch('runs/:id/items/:itemId')
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Override loss-of-pay days or hold pay, with a reason', body: itemOverrideInput })
  overrideItem(@Param('id', UuidPipe) id: string, @Param('itemId', UuidPipe) itemId: string, @Body(new ZodPipe(itemOverrideInput)) body: z.infer<typeof itemOverrideInput>) {
    return this.runs.overrideItem(id, itemId, body);
  }

  @Post('runs/:id/adjustments')
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Add a one-off earning or deduction for an employee', body: adjustmentInput })
  addAdjustment(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(adjustmentInput)) body: z.infer<typeof adjustmentInput>) {
    return this.runs.addAdjustment(id, body);
  }

  @Delete('runs/:id/adjustments/:adjustmentId')
  @HttpCode(204)
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Remove an adjustment' })
  removeAdjustment(@Param('id', UuidPipe) id: string, @Param('adjustmentId', UuidPipe) adjustmentId: string) {
    return this.runs.removeAdjustment(id, adjustmentId);
  }

  @Post('runs/:id/submit')
  @HttpCode(200)
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Send a computed run for approval' })
  submit(@Param('id', UuidPipe) id: string) {
    return this.runs.submit(id);
  }

  @Post('runs/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Take a run back from approval to change it' })
  withdraw(@Param('id', UuidPipe) id: string) {
    return this.runs.withdraw(id);
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Cancel a run that is not finalised', body: reasonInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reasonInput)) body: z.infer<typeof reasonInput>) {
    return this.runs.cancel(id, body.reason);
  }

  @Get('runs/:id/register.csv')
  @RequirePermission('payroll:read')
  @Doc({ summary: 'Download the payroll register (CSV)' })
  async register(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    sendCsv(res, await this.runs.register(id));
  }

  @Get('runs/:id/bank-file.csv')
  @RequirePermission('payroll:run')
  @Doc({ summary: 'Download the bank transfer file for a finalised run (CSV, audited)' })
  async bankFile(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    const f = await this.runs.bankFile(id);
    res.setHeader('x-missing-bank-details', String(f.missingBankDetails.length));
    sendCsv(res, f);
  }
}

@Controller('payslips')
@RequireFeature('payroll')
export class PayslipsController {
  constructor(private readonly payslips: PayslipsService) {}

  @Get()
  @RequirePermission('payslips:read')
  @Doc({ summary: 'Payslips you can see (mine=true for your own)', query: payslipQuery })
  list(@Query(new ZodPipe(payslipQuery)) q: z.infer<typeof payslipQuery>) {
    return this.payslips.list({ employeeId: q.employeeId, mine: q.mine === 'true' });
  }

  @Get(':id')
  @RequirePermission('payslips:read')
  @Doc({ summary: 'One payslip with every line explained and year-to-date totals' })
  get(@Param('id', UuidPipe) id: string) {
    return this.payslips.get(id);
  }
}

@Controller('expenses')
@RequireFeature('expenses')
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly config: PayrollConfigService,
  ) {}

  @Get('categories')
  @Doc({ summary: 'Expense categories', query: categoryQuery })
  categories(@Query(new ZodPipe(categoryQuery)) q: z.infer<typeof categoryQuery>) {
    return this.config.listCategories(q.includeArchived === 'true');
  }

  @Post('categories')
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Add an expense category', body: expenseCategoryInput })
  createCategory(@Body(new ZodPipe(expenseCategoryInput)) body: z.infer<typeof expenseCategoryInput>) {
    return this.config.saveCategory(null, body);
  }

  @Put('categories/:id')
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Change an expense category', body: expenseCategoryInput })
  updateCategory(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(expenseCategoryInput)) body: z.infer<typeof expenseCategoryInput>) {
    return this.config.saveCategory(id, body);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @RequirePermission('payroll:configure')
  @Doc({ summary: 'Archive an expense category' })
  archiveCategory(@Param('id', UuidPipe) id: string) {
    return this.config.archiveCategory(id);
  }

  @Get('claims')
  @Doc({ summary: 'Expense claims: yours, waiting for your decision, or all you may approve', query: claimQuery })
  claims(@Query(new ZodPipe(claimQuery)) q: z.infer<typeof claimQuery>) {
    return this.expenses.list(q);
  }

  @Post('claims')
  @RequirePermission('expenses:submit')
  @UseInterceptors(FileInterceptor('receipt', { limits: { fileSize: RECEIPT_MAX_BYTES, files: 1, fields: 10, fieldSize: 2_000 } }))
  @Doc({ summary: 'Submit an expense claim (multipart/form-data with the fields below and an optional "receipt" file part)', body: expenseClaimInput })
  submit(@Body(new ZodPipe(expenseClaimInput)) body: z.infer<typeof expenseClaimInput>, @File() file?: UploadedFile) {
    return this.expenses.submit(body, file);
  }

  @Get('claims/:id')
  @Doc({ summary: 'One expense claim' })
  claim(@Param('id', UuidPipe) id: string) {
    return this.expenses.get(id);
  }

  @Post('claims/:id/cancel')
  @HttpCode(200)
  @RequirePermission('expenses:submit')
  @Doc({ summary: 'Withdraw your pending claim' })
  cancel(@Param('id', UuidPipe) id: string) {
    return this.expenses.cancel(id);
  }

  @Post('claims/:id/receipt-link')
  @HttpCode(200)
  @Doc({ summary: 'A 5-minute link to the claim’s receipt (audited)' })
  receipt(@Param('id', UuidPipe) id: string) {
    return this.expenses.receiptLink(id);
  }
}

@Controller('files/receipts')
export class ReceiptFilesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get(':id')
  @Public()
  @Doc({ summary: 'Download an expense receipt through a signed link', query: fileQuery })
  async file(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>, @Res() res: Response) {
    const f = await this.expenses.openReceipt(id, q.exp, q.sig);
    res.setHeader('content-type', f.contentType);
    res.setHeader('content-length', String(f.size));
    res.setHeader('content-disposition', `attachment; filename="${f.fileName.replace(/"/g, '')}"`);
    res.setHeader('cache-control', 'private, no-store');
    f.stream.pipe(res);
  }
}
