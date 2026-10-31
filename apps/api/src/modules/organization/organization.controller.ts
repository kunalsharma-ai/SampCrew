import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { businessUnitInput, departmentInput, legalEntityInput, locationInput } from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { OrganizationService, type OrgTable } from './organization.service';

const listQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });

const partial = <T extends z.ZodType>(schema: T) => {
  // Location input has refinements; for PATCH we validate the plain object shape partially and rely on DB checks for cross-field rules.
  const base = schema instanceof z.ZodObject ? schema : ((schema as unknown as { _zod: { def: { in?: z.ZodObject } } })._zod.def.in ?? z.object({}));
  return (base as z.ZodObject).partial().strict();
};

function makeController(path: string, table: OrgTable, schema: z.ZodType, label: string) {
  const patchSchema = partial(schema);

  @Controller(`org/${path}`)
  class OrgResourceController {
    constructor(readonly org: OrganizationService) {}

    @Get()
    @RequirePermission('org:read')
    @Doc({ summary: `List ${label}`, query: listQuery })
    list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
      return this.org.list(table, q.includeArchived === 'true');
    }

    @Get(':id')
    @RequirePermission('org:read')
    @Doc({ summary: `Get one of the ${label}` })
    get(@Param('id', UuidPipe) id: string) {
      return this.org.get(table, id);
    }

    @Post()
    @RequirePermission('org:manage')
    @Doc({ summary: `Create ${label.replace(/s$/, '')}`, body: schema })
    create(@Body(new ZodPipe(schema)) body: Record<string, unknown>) {
      return this.org.create(table, body);
    }

    @Patch(':id')
    @RequirePermission('org:manage')
    @Doc({ summary: `Update ${label.replace(/s$/, '')}`, body: patchSchema })
    update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(patchSchema)) body: Record<string, unknown>) {
      return this.org.update(table, id, body);
    }

    @Delete(':id')
    @RequirePermission('org:manage')
    @HttpCode(204)
    @Doc({ summary: `Archive ${label.replace(/s$/, '')} (history is kept)` })
    async archive(@Param('id', UuidPipe) id: string) {
      await this.org.archive(table, id);
    }
  }
  Object.defineProperty(OrgResourceController, 'name', { value: `${label.replace(/\s/g, '')}Controller` });
  return OrgResourceController;
}

export const LegalEntitiesController = makeController('legal-entities', 'legal_entities', legalEntityInput, 'Legal entities');
export const BusinessUnitsController = makeController('business-units', 'business_units', businessUnitInput, 'Business units');
export const LocationsController = makeController('locations', 'locations', locationInput, 'Locations');
export const DepartmentsController = makeController('departments', 'departments', departmentInput, 'Departments');

@Controller('org')
export class OrganizationController {
  constructor(private readonly org: OrganizationService) {}

  @Get('overview')
  @RequirePermission('org:read')
  @Doc({ summary: 'Counts of entities, locations, departments and members' })
  overview() {
    return this.org.overview();
  }

  @Get('department-tree')
  @RequirePermission('org:read')
  @Doc({ summary: 'Department hierarchy with member counts' })
  tree() {
    return this.org.departmentTree();
  }
}
