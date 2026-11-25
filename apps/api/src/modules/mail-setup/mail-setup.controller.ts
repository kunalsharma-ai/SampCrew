import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { tenantMailInput, tenantMailTestInput, type TenantMailInput } from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { MailSetupService } from './mail-setup.service';

/** Settings > Email setup: the company's own outgoing email server (Super Workspace). */
@Controller('settings/mail')
export class MailSetupController {
  constructor(private readonly mail: MailSetupService) {}

  @Get()
  @RequirePermission('mail:configure')
  @Doc({ summary: "The company's email server settings (never the password), how email leaves SampCrew now, and the latest emails sent" })
  get() {
    return this.mail.get();
  }

  @Put()
  @RequirePermission('mail:configure')
  @Doc({ summary: "Save the company's own email server. Switched on, every email SampCrew sends for the company goes through it", body: tenantMailInput })
  save(@Body(new ZodPipe(tenantMailInput)) body: TenantMailInput) {
    return this.mail.save(body);
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermission('mail:configure')
  @Doc({ summary: 'Sign in to the saved email server and send a real test email', body: tenantMailTestInput })
  test(@Body(new ZodPipe(tenantMailTestInput)) body: z.infer<typeof tenantMailTestInput>) {
    return this.mail.test(body.sendTo);
  }
}
