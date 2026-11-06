import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { setupCompanyInput, setupProgressInput, setupStructureInput, type SetupCompanyInput, type SetupStructureInput } from '@crew/contracts';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { SetupService } from './setup.service';

@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get()
  @RequirePermission('org:read')
  @Doc({ summary: 'Company setup: progress, company profile, departments and designations so far, and suggestions for the industry' })
  get() {
    return this.setup.get();
  }

  @Put('company')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Save the company profile (workspace and its main legal entity)', body: setupCompanyInput })
  company(@Body(new ZodPipe(setupCompanyInput)) body: SetupCompanyInput) {
    return this.setup.saveCompany(body);
  }

  @Post('structure')
  @HttpCode(200)
  @RequirePermission('org:manage')
  @Doc({ summary: 'Add departments and designations in one go (existing names are skipped)', body: setupStructureInput })
  structure(@Body(new ZodPipe(setupStructureInput)) body: SetupStructureInput) {
    return this.setup.addStructure(body);
  }

  @Post('progress')
  @HttpCode(200)
  @RequirePermission('org:manage')
  @Doc({ summary: 'Remember the furthest setup step reached', body: setupProgressInput })
  progress(@Body(new ZodPipe(setupProgressInput)) body: z.infer<typeof setupProgressInput>) {
    return this.setup.progress(body.step);
  }

  @Post('complete')
  @HttpCode(200)
  @RequirePermission('org:manage')
  @Doc({ summary: 'Finish company setup' })
  complete() {
    return this.setup.complete();
  }
}
