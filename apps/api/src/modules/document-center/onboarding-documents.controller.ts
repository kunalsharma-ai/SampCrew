import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  assignChecklistInput, libraryCategoryInput, libraryItemInput, libraryRequestDecision, libraryRequestInput, libraryTemplateInput,
  type AssignChecklistInput, type LibraryItemInput, type LibraryTemplateInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { OnboardingDocumentsService } from './onboarding-documents.service';

const listQuery = z.object({
  status: z.enum(['active', 'completed']).default('active'),
  q: z.string().trim().max(80).optional(),
  hrWorkspaceId: z.uuid().optional(),
  pending: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});
const optionsQuery = z.object({ employmentType: z.string().max(30).optional(), departmentId: z.uuid().optional() });

/**
 * Onboarding documents (issue #89): the Super Workspace's library and templates, checklists HR assigns, and each
 * employee's progress. Uploads, approval and rejection go through the document requests each checklist item is.
 */
@Controller('onboarding-documents')
@RequireFeature('documents')
export class OnboardingDocumentsController {
  constructor(private readonly docs: OnboardingDocumentsService) {}

  @Get('library')
  @Doc({ summary: 'The onboarding document library: categories, documents, templates, and requests to the Super Workspace' })
  library() {
    return this.docs.library();
  }

  @Post('library/categories')
  @Doc({ summary: 'Add a library category (Super Workspace, or HR with the library permission)', body: libraryCategoryInput })
  addCategory(@Body(new ZodPipe(libraryCategoryInput)) body: z.infer<typeof libraryCategoryInput>) {
    return this.docs.addCategory(body);
  }

  @Put('library/categories/:id')
  @Doc({ summary: 'Rename or describe a library category', body: libraryCategoryInput })
  updateCategory(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(libraryCategoryInput)) body: z.infer<typeof libraryCategoryInput>) {
    return this.docs.updateCategory(id, body);
  }

  @Post('library/categories/:id/archive')
  @HttpCode(200)
  @Doc({ summary: 'Remove an empty category from the library (kept, archived)' })
  archiveCategory(@Param('id', UuidPipe) id: string) {
    return this.docs.archiveCategory(id);
  }

  @Post('library/documents')
  @Doc({ summary: 'Add a document to the library: requirement, formats, size, files, instructions, verification notes', body: libraryItemInput })
  addItem(@Body(new ZodPipe(libraryItemInput)) body: LibraryItemInput) {
    return this.docs.addItem(body);
  }

  @Put('library/documents/:id')
  @Doc({ summary: 'Change a library document (or deactivate it with active false)', body: libraryItemInput })
  updateItem(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(libraryItemInput)) body: LibraryItemInput) {
    return this.docs.updateItem(id, body);
  }

  @Post('library/documents/:id/archive')
  @HttpCode(200)
  @Doc({ summary: 'Remove a document from the library. Documents already asked for keep their requests and history.' })
  archiveItem(@Param('id', UuidPipe) id: string) {
    return this.docs.archiveItem(id);
  }

  @Post('library/templates')
  @Doc({ summary: 'Add an onboarding template (documents, each required or optional; departments and employment types)', body: libraryTemplateInput })
  addTemplate(@Body(new ZodPipe(libraryTemplateInput)) body: LibraryTemplateInput) {
    return this.docs.addTemplate(body);
  }

  @Put('library/templates/:id')
  @Doc({ summary: 'Change an onboarding template', body: libraryTemplateInput })
  updateTemplate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(libraryTemplateInput)) body: LibraryTemplateInput) {
    return this.docs.updateTemplate(id, body);
  }

  @Post('library/templates/:id/archive')
  @HttpCode(200)
  @Doc({ summary: 'Remove an onboarding template (kept, archived)' })
  archiveTemplate(@Param('id', UuidPipe) id: string) {
    return this.docs.archiveTemplate(id);
  }

  @Post('library/requests')
  @Doc({ summary: 'HR asks the Super Workspace for a new document or for permission to manage the library', body: libraryRequestInput })
  request(@Body(new ZodPipe(libraryRequestInput)) body: z.infer<typeof libraryRequestInput>) {
    return this.docs.requestToSuper(body);
  }

  @Post('library/requests/:id/decide')
  @HttpCode(200)
  @Doc({ summary: 'The Super Workspace approves (adds the document, or gives the permission) or declines', body: libraryRequestDecision })
  decide(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(libraryRequestDecision)) body: z.infer<typeof libraryRequestDecision>) {
    return this.docs.decideRequest(id, body);
  }

  @Get('assign-options')
  @Doc({ summary: 'Templates and library documents to assign, with the template suggested for an employment type and department', query: optionsQuery })
  options(@Query(new ZodPipe(optionsQuery)) q: z.infer<typeof optionsQuery>) {
    return this.docs.assignOptions(q);
  }

  @Get('checklists')
  @Doc({ summary: 'Onboarding checklists the viewer may see, with each employee\'s progress (HR and Super Workspace)', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.docs.list(q);
  }

  @Get('checklists/:id')
  @Doc({ summary: 'One checklist: every document with its status, HR comments and files' })
  get(@Param('id', UuidPipe) id: string) {
    return this.docs.get(id);
  }

  @Get('mine')
  @Doc({ summary: 'My onboarding documents: the active checklist and completed ones' })
  mine() {
    return this.docs.mine();
  }

  @Get('employees/:id')
  @Doc({ summary: 'An employee\'s onboarding checklists (their onboarding history)' })
  forEmployee(@Param('id', UuidPipe) id: string) {
    return this.docs.forEmployee(id);
  }

  @Post('employees/:id/checklist')
  @Doc({ summary: 'Assign onboarding documents to an employee, or add documents to their checklist (never twice)', body: assignChecklistInput })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assignChecklistInput)) body: AssignChecklistInput) {
    return this.docs.assign(id, body);
  }
}
