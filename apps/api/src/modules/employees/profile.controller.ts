import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { PROFILE_SECTIONS, profileChangeInput, profileChangesQuery, profileDecisionInput, type ProfileSection } from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature } from '../../platform/authz/decorators';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { ProfileService } from './profile.service';

const sectionOf = (s: string): ProfileSection => {
  if (!(PROFILE_SECTIONS as readonly string[]).includes(s)) throw Errors.notFound('Profile section');
  return s as ProfileSection;
};

/** The complete employee profile and the profile updates employees submit for HR approval. */
@Controller('profile')
@RequireFeature('core_hr')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('me')
  @Doc({ summary: 'My complete profile (bank and identity numbers masked) with my pending updates' })
  async me() {
    return this.profile.get(await this.profile.myEmployeeId());
  }

  @Get('sections')
  @Doc({ summary: 'Profile sections in order, and which hold encrypted numbers' })
  sections() {
    return this.profile.sections();
  }

  @Get('updates')
  @Doc({ summary: 'Profile updates I can review (pending by default)', query: profileChangesQuery })
  list(@Query(new ZodPipe(profileChangesQuery)) q: z.infer<typeof profileChangesQuery>) {
    return this.profile.list(q.status);
  }

  @Get('updates/mine')
  @Doc({ summary: 'My own profile updates and their status' })
  mine() {
    return this.profile.mine();
  }

  @Get('updates/:id')
  @Doc({ summary: 'One profile update: old and new values, linked documents, the approval trail' })
  get(@Param('id', UuidPipe) id: string) {
    return this.profile.get1(id);
  }

  @Post('updates/:id/decide')
  @HttpCode(200)
  @Doc({ summary: 'Approve, reject or ask for more information (reject and ask need remarks)', body: profileDecisionInput })
  decide(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(profileDecisionInput)) body: z.infer<typeof profileDecisionInput>) {
    return this.profile.decide(id, body);
  }

  @Post('updates/:id/cancel')
  @HttpCode(200)
  @Doc({ summary: 'Withdraw my profile update while it is open' })
  cancel(@Param('id', UuidPipe) id: string) {
    return this.profile.cancel(id);
  }

  @Get(':employeeId')
  @Doc({ summary: 'An employee\'s complete profile, as far as I may see it' })
  one(@Param('employeeId', UuidPipe) employeeId: string) {
    return this.profile.get(employeeId);
  }

  @Post(':employeeId/updates')
  @Doc({ summary: 'Submit a profile update for my own profile; HR approves it before it is applied', body: profileChangeInput })
  submit(@Param('employeeId', UuidPipe) employeeId: string, @Body(new ZodPipe(profileChangeInput)) body: z.infer<typeof profileChangeInput>) {
    return this.profile.submit(employeeId, body);
  }

  @Put(':employeeId/sections/:section')
  @Doc({ summary: 'HR changes a section of someone\'s profile directly (bank and identity also need employees:sensitive:read)' })
  edit(@Param('employeeId', UuidPipe) employeeId: string, @Param('section') section: string, @Body() body: unknown) {
    return this.profile.edit(employeeId, sectionOf(section), body);
  }
}
