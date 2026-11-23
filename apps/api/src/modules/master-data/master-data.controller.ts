import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { MASTER_LISTS, masterLibraryAddInput, masterListQuery, masterValueInput, masterValueUpdate } from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { MasterDataService } from './master-data.service';

const listParam = z.enum(MASTER_LISTS);
const ListPipe = new ZodPipe(listParam);

/**
 * Master data: the lists behind SampCrew's dropdowns (industries, departments, job titles, job roles, skills,
 * education, candidate sources, seniority levels, locations, employment types and statuses).
 */
@Controller('master-data')
export class MasterDataController {
  constructor(private readonly master: MasterDataService) {}

  @Get()
  @RequirePermission('org:read')
  @Doc({ summary: 'Every master data list with how many values it has and whether you can change it' })
  lists() {
    return this.master.lists();
  }

  @Get(':list')
  @RequirePermission('org:read')
  @Doc({ summary: 'The values of one list: search by name or code, filter by category, disabled ones with disabled=true or all', query: masterListQuery })
  values(@Param('list', ListPipe) list: z.infer<typeof listParam>, @Query(new ZodPipe(masterListQuery)) q: z.infer<typeof masterListQuery>) {
    return this.master.values(list, q);
  }

  @Get(':list/options')
  @Doc({ summary: 'Active values of a list for a dropdown (anyone signed in)' })
  options(@Param('list', ListPipe) list: z.infer<typeof listParam>) {
    return this.master.options(list);
  }

  @Get(':list/library')
  @RequirePermission('org:read')
  @Doc({ summary: 'The ready-made values of a list, each marked when the workspace already has it' })
  library(@Param('list', ListPipe) list: z.infer<typeof listParam>) {
    return this.master.library(list);
  }

  @Post(':list/library')
  @Doc({ summary: 'Add chosen library values to a list (masterdata:manage; departments org:manage)', body: masterLibraryAddInput })
  addFromLibrary(@Param('list', ListPipe) list: z.infer<typeof listParam>, @Body(new ZodPipe(masterLibraryAddInput)) body: z.infer<typeof masterLibraryAddInput>) {
    return this.master.addFromLibrary(list, body.labels);
  }

  @Post(':list')
  @Doc({ summary: 'Add your own value to a list (masterdata:manage; departments org:manage)', body: masterValueInput })
  create(@Param('list', ListPipe) list: z.infer<typeof listParam>, @Body(new ZodPipe(masterValueInput)) body: z.infer<typeof masterValueInput>) {
    return this.master.create(list, body);
  }

  @Patch(':list/:id')
  @Doc({ summary: 'Rename, recategorise, recode, disable or enable a value. Values in use are disabled, never deleted.', body: masterValueUpdate })
  update(@Param('list', ListPipe) list: z.infer<typeof listParam>, @Param('id', UuidPipe) id: string, @Body(new ZodPipe(masterValueUpdate)) body: z.infer<typeof masterValueUpdate>) {
    return this.master.update(list, id, body);
  }
}
