import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ssoConnectionInput, type SsoConnectionInput, ssoStatusInput } from '@crew/contracts';
import type { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { ScimService } from './scim.service';
import { SsoService } from './sso.service';

/** Owners set up single sign-on and SCIM provisioning (Enterprise plan). */
@Controller('security')
@RequireFeature('sso')
@RequirePermission('security:manage')
export class IdentityController {
  constructor(
    private readonly sso: SsoService,
    private readonly scim: ScimService,
  ) {}

  @Get('sso')
  @Doc({ summary: 'The single sign-on connection (the client secret is never returned) and the redirect URI to register' })
  getSso() {
    return this.sso.get();
  }

  @Put('sso')
  @Doc({ summary: 'Create or change the OpenID Connect connection. A new provider or client must pass a test sign-in again.', body: ssoConnectionInput })
  saveSso(@Body(new ZodPipe(ssoConnectionInput)) body: SsoConnectionInput) {
    return this.sso.save(body);
  }

  @Post('sso/test')
  @HttpCode(200)
  @Doc({ summary: 'Start a test sign-in; the connection is marked tested when it succeeds' })
  testSso() {
    return this.sso.startTest();
  }

  @Post('sso/status')
  @HttpCode(200)
  @Doc({ summary: 'Switch single sign-on on or off, and require it for members (owners can still use a password)', body: ssoStatusInput })
  ssoStatus(@Body(new ZodPipe(ssoStatusInput)) body: z.infer<typeof ssoStatusInput>) {
    return this.sso.setStatus(body.status, body.enforced);
  }

  @Delete('sso')
  @Doc({ summary: 'Switch single sign-on off and release its email domains' })
  removeSso() {
    return this.sso.remove();
  }

  @Get('scim')
  @Doc({ summary: 'SCIM provisioning: the current token (prefix only), people provisioned and recent calls' })
  scimStatus() {
    return this.scim.status();
  }

  @Post('scim/token')
  @Doc({ summary: 'Create a SCIM token, replacing the current one. The token is in this response only.' })
  scimToken() {
    return this.scim.createToken();
  }

  @Post('scim/token/revoke')
  @HttpCode(200)
  @Doc({ summary: 'Revoke the SCIM token; provisioning stops at once' })
  revokeScim() {
    return this.scim.revokeToken();
  }
}
