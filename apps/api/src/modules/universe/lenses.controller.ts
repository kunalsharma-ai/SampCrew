import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { RECRUITMENT_FLOW_PERIODS, scenarioInput, type ScenarioInput, setEmployeeSkillsInput, type SetEmployeeSkillsInput } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { LensesService } from './lenses.service';

const scenarioRequisitionsInput = z.object({ departmentIds: z.array(z.string().uuid()).min(1).max(100).optional() }).strict();
const flowQuery = z.object({ period: z.enum(RECRUITMENT_FLOW_PERIODS).default('quarter') }).strict();

@Controller()
export class LensesController {
  constructor(private readonly lenses: LensesService) {}

  @Get('insights/skills')
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
  @RequirePermission('reports:read')
  @Doc({ summary: 'Headcount scenarios: today’s baseline per department (with monthly cost when your payroll access covers everyone) and the saved scenarios' })
  scenarios() {
    return this.lenses.scenarios();
  }

  @Post('insights/scenarios')
  @RequirePermission('reports:read')
  @Doc({ summary: 'Save a headcount scenario', body: scenarioInput })
  create(@Body(new ZodPipe(scenarioInput)) body: ScenarioInput) {
    return this.lenses.saveScenario(null, body);
  }

  @Put('insights/scenarios/:id')
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
  @RequirePermission('reports:read')
  @Doc({ summary: 'Delete a headcount scenario' })
  remove(@Param('id', UuidPipe) id: string) {
    return this.lenses.deleteScenario(id);
  }
}
