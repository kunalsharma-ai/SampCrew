import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  RECRUITMENT_FLOW_PERIODS, requisitionSkillsInput, type RequisitionSkillsInput, skillCreateInput, type SkillCreateInput, skillMergeInput, skillUpdateInput, type SkillUpdateInput,
  scenarioInput, type ScenarioInput, setEmployeeSkillsInput, type SetEmployeeSkillsInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { LensesService } from './lenses.service';
import { SkillCatalogueService } from './skill-catalogue.service';

const scenarioRequisitionsInput = z.object({ departmentIds: z.array(z.string().uuid()).min(1).max(100).optional() }).strict();
const flowQuery = z.object({ period: z.enum(RECRUITMENT_FLOW_PERIODS).default('quarter') }).strict();

@Controller()
export class LensesController {
  constructor(private readonly lenses: LensesService, private readonly catalogue: SkillCatalogueService) {}

  @Get('insights/skills')
  @RequireFeature('workforce_universe')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Skills network: the skills held by the people you can see, with their level' })
  skills() {
    return this.lenses.network();
  }

  @Get('employees/:id/skills')
  @RequirePermission('employees:read')
  @Doc({ summary: 'A person’s skills, and whether you may change them' })
  skillsOf(@Param('id', UuidPipe) id: string) {
    return this.lenses.skillsOf(id);
  }

  @Put('employees/:id/skills')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Replace a person’s skills (needs update access to that person). New skill names join the workspace list.', body: setEmployeeSkillsInput })
  setSkills(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(setEmployeeSkillsInput)) body: SetEmployeeSkillsInput) {
    return this.lenses.setSkills(id, body);
  }

  @Get('insights/recruitment-flow')
  @RequireFeature('recruitment')
  @RequirePermission('requisitions:read')
  @Doc({ summary: 'Recruitment flow: how applications made in the period moved between stages, and where they stopped' })
  flow(@Query(new ZodPipe(flowQuery)) q: z.infer<typeof flowQuery>) {
    return this.lenses.recruitmentFlow(q.period);
  }

  @Get('insights/scenarios')
  @RequireFeature('workforce_universe')
  @RequirePermission('reports:read')
  @Doc({ summary: 'Headcount scenarios: today’s baseline per department (with monthly cost when your payroll access covers everyone) and the saved scenarios' })
  scenarios() {
    return this.lenses.scenarios();
  }

  @Post('insights/scenarios')
  @RequireFeature('workforce_universe')
  @RequirePermission('reports:read')
  @Doc({ summary: 'Save a headcount scenario', body: scenarioInput })
  create(@Body(new ZodPipe(scenarioInput)) body: ScenarioInput) {
    return this.lenses.saveScenario(null, body);
  }

  @Put('insights/scenarios/:id')
  @RequireFeature('workforce_universe')
  @RequirePermission('reports:read')
  @Doc({ summary: 'Update a headcount scenario', body: scenarioInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(scenarioInput)) body: ScenarioInput) {
    return this.lenses.saveScenario(id, body);
  }

  @Post('insights/scenarios/:id/requisitions')
  @RequireFeature('recruitment')
  @RequirePermission('requisitions:create')
  @Doc({ summary: 'Raise draft requisitions for the departments a scenario adds people to (once per department)', body: scenarioRequisitionsInput })
  raise(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(scenarioRequisitionsInput)) body: z.infer<typeof scenarioRequisitionsInput>) {
    return this.lenses.scenarioRequisitions(id, body.departmentIds);
  }

  @Delete('insights/scenarios/:id')
  @RequireFeature('workforce_universe')
  @RequirePermission('reports:read')
  @Doc({ summary: 'Delete a headcount scenario' })
  remove(@Param('id', UuidPipe) id: string) {
    return this.lenses.deleteScenario(id);
  }

  // ---- Skill list and job skills ----

  @Get('skills')
  @RequirePermission('employees:read')
  @Doc({ summary: 'The workspace’s skill list, with holders among the people you can see and the jobs that ask for each' })
  catalogueList() {
    return this.catalogue.catalogue();
  }

  @Post('skills')
  @RequirePermission('employees:update')
  @Doc({ summary: 'Add a skill to the list (people who may update every employee record)', body: skillCreateInput })
  catalogueCreate(@Body(new ZodPipe(skillCreateInput)) body: SkillCreateInput) {
    return this.catalogue.create(body);
  }

  @Patch('skills/:id')
  @RequirePermission('employees:update')
  @Doc({ summary: 'Rename a skill or change its category', body: skillUpdateInput })
  catalogueUpdate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(skillUpdateInput)) body: SkillUpdateInput) {
    return this.catalogue.update(id, body);
  }

  @Post('skills/:id/merge')
  @RequirePermission('employees:update')
  @Doc({ summary: 'Merge a skill into another: holders and jobs move over at the higher level, then the skill is removed', body: skillMergeInput })
  catalogueMerge(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(skillMergeInput)) body: { intoId: string }) {
    return this.catalogue.merge(id, body.intoId);
  }

  @Delete('skills/:id')
  @RequirePermission('employees:update')
  @Doc({ summary: 'Remove a skill from the list and from everyone who holds it' })
  catalogueDelete(@Param('id', UuidPipe) id: string) {
    return this.catalogue.remove(id);
  }

  @Get('recruitment/requisitions/:id/skills')
  @RequireFeature('recruitment')
  @RequirePermission('requisitions:read')
  @Doc({ summary: 'Skills a job asks for, and the people you can see who have them, best match first' })
  jobSkills(@Param('id', UuidPipe) id: string) {
    return this.catalogue.forRequisition(id);
  }

  @Put('recruitment/requisitions/:id/skills')
  @RequireFeature('recruitment')
  @RequirePermission('requisitions:create')
  @Doc({ summary: 'Set the skills a job asks for, with the lowest level that counts', body: requisitionSkillsInput })
  setJobSkills(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(requisitionSkillsInput)) body: RequisitionSkillsInput) {
    return this.catalogue.setForRequisition(id, body);
  }
}
