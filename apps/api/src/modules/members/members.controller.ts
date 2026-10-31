import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { assignRolesRequest, inviteMemberRequest, paginationQuery, updateMemberRequest } from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { MembersService } from './members.service';

const listQuery = paginationQuery.extend({ status: z.enum(['invited', 'active', 'suspended']).optional(), departmentId: z.uuid().optional() });

@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission('users:read')
  @Doc({ summary: 'List members visible to you (own / team / department / entity / all, per your roles)', query: listQuery })
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.members.list(q);
  }

  @Get(':id')
  @RequirePermission('users:read')
  @Doc({ summary: 'Get a member' })
  get(@Param('id', UuidPipe) id: string) {
    return this.members.get(id);
  }

  @Post('invite')
  @RequirePermission('users:invite')
  @Doc({ summary: 'Invite a person and assign roles', body: inviteMemberRequest })
  invite(@Body(new ZodPipe(inviteMemberRequest)) body: z.infer<typeof inviteMemberRequest>) {
    return this.members.invite(body);
  }

  @Post(':id/resend-invite')
  @RequirePermission('users:invite')
  @Doc({ summary: 'Issue a fresh invitation link' })
  resend(@Param('id', UuidPipe) id: string) {
    return this.members.resendInvite(id);
  }

  @Patch(':id')
  @RequirePermission('users:manage')
  @Doc({ summary: 'Change placement (entity, department, location, manager) or suspend / reactivate', body: updateMemberRequest })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(updateMemberRequest)) body: z.infer<typeof updateMemberRequest>) {
    return this.members.update(id, body);
  }

  @Put(':id/roles')
  @RequirePermission('roles:manage')
  @Doc({ summary: 'Replace role assignments, optionally constrained to entities, departments or locations', body: assignRolesRequest })
  roles(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(assignRolesRequest)) body: z.infer<typeof assignRolesRequest>) {
    return this.members.setRoles(id, body);
  }
}
