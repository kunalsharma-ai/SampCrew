import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  acceptInviteRequest,
  changePasswordRequest,
  loginRequest,
  mfaEnableRequest,
  mfaVerifyRequest,
  refreshRequest,
  selectTenantRequest,
  signupRequest,
  samlCallbackInput,
  ssoCallbackInput,
  ssoExchangeInput,
  initialPasswordRequest,
  ssoStartInput,
  switchTenantRequest,
  passwordResetCheck,
  passwordResetComplete,
  passwordResetRequest,
  passwordResetsQuery,
} from '@crew/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { AllowWithoutMfa, Public, AllowWhenLocked, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { SsoService } from '../identity/sso.service';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';

const clientOf = (req: Request) => {
  const c = req.headers['x-crew-client'];
  return c === 'mobile' || c === 'api' ? c : 'web';
};

@Controller('auth')
@AllowWhenLocked()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sso: SsoService,
    private readonly resets: PasswordResetService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password-reset/request')
  @HttpCode(200)
  @Doc({ summary: 'Forgot password: emails a single-use reset link and a 6-digit code (30 minutes) to the account with this email. The answer is the same whether or not an account exists.', body: passwordResetRequest })
  passwordResetRequest(@Body(new ZodPipe(passwordResetRequest)) body: z.infer<typeof passwordResetRequest>, @Req() req: Request) {
    return this.resets.request('user', body.email, clientOf(req));
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('password-reset/check')
  @HttpCode(200)
  @Doc({ summary: 'Whether a reset link still works (for the reset page)', body: passwordResetCheck })
  passwordResetCheck(@Body(new ZodPipe(passwordResetCheck)) body: z.infer<typeof passwordResetCheck>) {
    return this.resets.check('user', body.token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('password-reset/complete')
  @HttpCode(200)
  @Doc({ summary: 'Set a new password with the reset link (token) or the email and 6-digit code; signs out every session', body: passwordResetComplete })
  passwordResetComplete(@Body(new ZodPipe(passwordResetComplete)) body: z.infer<typeof passwordResetComplete>) {
    return this.resets.complete('user', body);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('sso/start')
  @HttpCode(200)
  @Doc({ summary: 'Start single sign-on for a work email: returns the identity provider address to send the browser to', body: ssoStartInput })
  ssoStart(@Body(new ZodPipe(ssoStartInput)) body: z.infer<typeof ssoStartInput>, @Req() req: Request) {
    return this.sso.startByEmail(body.email, clientOf(req) === 'mobile' ? 'mobile' : 'web', { returnTo: body.returnTo, appChallenge: body.appChallenge });
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sso/callback')
  @HttpCode(200)
  @Doc({ summary: 'Finish single sign-on with the code and state the identity provider returned', body: ssoCallbackInput })
  ssoCallback(@Body(new ZodPipe(ssoCallbackInput)) body: z.infer<typeof ssoCallbackInput>) {
    return this.auth.ssoCallback(body.code, body.state);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sso/saml/callback')
  @HttpCode(200)
  @Doc({ summary: 'Finish SAML single sign-on with the SAMLResponse and RelayState the identity provider posted to the Web Portal', body: samlCallbackInput })
  ssoSamlCallback(@Body(new ZodPipe(samlCallbackInput)) body: z.infer<typeof samlCallbackInput>) {
    return this.auth.ssoSamlCallback(body.samlResponse, body.relayState);
  }

  @Public()
  @Get('sso/saml/metadata')
  @Header('content-type', 'application/samlmetadata+xml; charset=utf-8')
  @Doc({ summary: "SampCrew's SAML service provider metadata (entity ID and Assertion Consumer Service), to load into the identity provider" })
  ssoSamlMetadata() {
    return this.sso.samlMetadata();
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('sso/exchange')
  @HttpCode(200)
  @Doc({ summary: 'Mobile app: exchange the one-time single sign-on code, with the PKCE verifier behind the challenge it started with, for a session', body: ssoExchangeInput })
  ssoExchange(@Body(new ZodPipe(ssoExchangeInput)) body: z.infer<typeof ssoExchangeInput>) {
    return this.auth.ssoExchange(body.code, body.verifier);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  @Doc({ summary: 'Create a workspace (tenant) and its owner account; starts a 14-day Professional trial', body: signupRequest })
  signup(@Body(new ZodPipe(signupRequest)) body: z.infer<typeof signupRequest>, @Req() req: Request) {
    return this.auth.signup(body, clientOf(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @Doc({ summary: 'Sign in with email and password. May return an MFA challenge or a workspace picker.', body: loginRequest })
  login(@Body(new ZodPipe(loginRequest)) body: z.infer<typeof loginRequest>, @Req() req: Request) {
    return this.auth.login(body.email, body.password, body.tenantSlug, clientOf(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  @HttpCode(200)
  @Doc({ summary: 'Complete sign-in with a 6-digit authenticator code', body: mfaVerifyRequest })
  verifyMfa(@Body(new ZodPipe(mfaVerifyRequest)) body: z.infer<typeof mfaVerifyRequest>) {
    return this.auth.verifyMfa(body.mfaToken, body.code);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('initial-password')
  @HttpCode(200)
  @Doc({ summary: 'First sign-in with a temporary password: choose your own password, then continue signing in', body: initialPasswordRequest })
  initialPassword(@Body(new ZodPipe(initialPasswordRequest)) body: z.infer<typeof initialPasswordRequest>) {
    return this.auth.setInitialPassword(body.changeToken, body.newPassword);
  }

  @Public()
  @Post('select-tenant')
  @HttpCode(200)
  @Doc({ summary: 'Choose a workspace when the account belongs to several', body: selectTenantRequest })
  selectTenant(@Body(new ZodPipe(selectTenantRequest)) body: z.infer<typeof selectTenantRequest>) {
    return this.auth.selectTenant(body.selectToken, body.tenantId);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @Doc({ summary: 'Rotate the refresh token and get a new access token', body: refreshRequest })
  refresh(@Body(new ZodPipe(refreshRequest)) body: z.infer<typeof refreshRequest>) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @AllowWithoutMfa()
  @HttpCode(204)
  @Doc({ summary: 'Sign out and revoke this session family' })
  async logout() {
    await this.auth.logout();
  }

  @Post('switch-tenant')
  @AllowWithoutMfa()
  @HttpCode(200)
  @Doc({ summary: 'Switch to another workspace the user belongs to', body: switchTenantRequest })
  switchTenant(@Body(new ZodPipe(switchTenantRequest)) body: z.infer<typeof switchTenantRequest>) {
    return this.auth.switchTenant(body.tenantId);
  }

  @Public()
  @Get('invitations/:token')
  @Doc({ summary: 'Preview an invitation before accepting it' })
  invitation(@Param('token') token: string) {
    return this.auth.invitationPreview(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invitations/accept')
  @HttpCode(200)
  @Doc({ summary: 'Accept an invitation, set a password (or confirm an existing one) and sign in', body: acceptInviteRequest })
  accept(@Body(new ZodPipe(acceptInviteRequest)) body: z.infer<typeof acceptInviteRequest>, @Req() req: Request) {
    return this.auth.acceptInvitation(body.token, body.fullName, body.password, clientOf(req));
  }
}

@Controller('me')
@AllowWhenLocked()
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @AllowWithoutMfa()
  @Doc({ summary: 'Current user, workspace, roles, effective permissions, plan features and limits' })
  me() {
    return this.auth.me();
  }

  @Get('sessions')
  @AllowWithoutMfa()
  @Doc({ summary: 'Active sessions for this account in this workspace' })
  sessions() {
    return this.auth.sessions();
  }

  @Get('sign-ins')
  @AllowWithoutMfa()
  @Doc({ summary: 'Your recent sign-ins in this workspace (newest first): when, which app, device and whether the session is still open; the previous successful sign-in' })
  signIns() {
    return this.auth.signIns();
  }

  @Post('sessions/sign-out-others')
  @AllowWithoutMfa()
  @HttpCode(200)
  @Doc({ summary: 'Sign out every other session of this account in this workspace (this one stays signed in)' })
  signOutOthers() {
    return this.auth.signOutOthers();
  }

  @Delete('sessions/:id')
  @AllowWithoutMfa()
  @HttpCode(204)
  @Doc({ summary: 'Revoke one of your sessions' })
  async revoke(@Param('id', UuidPipe) id: string) {
    await this.auth.revokeSession(id);
  }

  @Post('mfa/setup')
  @AllowWithoutMfa()
  @Doc({ summary: 'Start authenticator-app enrolment; returns the secret and otpauth URI for a QR code' })
  mfaSetup() {
    return this.auth.mfaSetup();
  }

  @Post('mfa/enable')
  @AllowWithoutMfa()
  @HttpCode(200)
  @Doc({ summary: 'Confirm enrolment with a first code; returns an MFA-verified session', body: mfaEnableRequest })
  mfaEnable(@Body(new ZodPipe(mfaEnableRequest)) body: z.infer<typeof mfaEnableRequest>) {
    return this.auth.mfaEnable(body.code);
  }

  @Post('mfa/verify')
  @AllowWithoutMfa()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Doc({ summary: 'Verify this session with a 6-digit authenticator code (step-up); returns an MFA-verified session', body: mfaEnableRequest })
  mfaStepUp(@Body(new ZodPipe(mfaEnableRequest)) body: z.infer<typeof mfaEnableRequest>) {
    return this.auth.mfaStepUp(body.code);
  }

  @Post('password')
  @HttpCode(204)
  @Doc({ summary: 'Change password; signs out other sessions', body: changePasswordRequest })
  async password(@Body(new ZodPipe(changePasswordRequest)) body: z.infer<typeof changePasswordRequest>) {
    await this.auth.changePassword(body.currentPassword, body.newPassword);
  }
}

/** Super Workspace: password resets by the company's own people, newest first. */
@Controller('password-resets')
export class PasswordResetsController {
  constructor(private readonly resets: PasswordResetService) {}

  @Get()
  @RequirePermission('users:read')
  @Doc({ summary: 'Super Workspace: "forgot password" requests and completed resets by the people of this company (HR Workspace and Employee Workspace included)', query: passwordResetsQuery })
  list(@Query(new ZodPipe(passwordResetsQuery)) q: z.infer<typeof passwordResetsQuery>) {
    return this.resets.workspaceList(q);
  }
}
