import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { saveSignatureInput, signatureBannerInput, type SignatureBannerInput, type SaveSignatureInput, signatureAgentReport, signatureAgentSyncInput, signatureSettingsInput, type SignatureSettingsInput } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { LOGO_MAX_BYTES, SignaturesService } from './signatures.service';

const agentNameInput = z.object({ name: z.string().trim().min(1, 'Name this computer').max(80) }).strict();

function sendFile(res: Response, f: { stream: NodeJS.ReadableStream; size: number; contentType: string }) {
  res.setHeader('content-type', f.contentType);
  res.setHeader('content-length', String(f.size));
  res.setHeader('cache-control', 'private, max-age=300');
  res.setHeader('x-content-type-options', 'nosniff');
  f.stream.pipe(res);
}

/** Email signatures for Outlook: company settings, each person's own signature and the computers that install it. */
@Controller('signatures')
@RequireFeature('email_signatures')
export class SignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get('me')
  @Doc({ summary: 'Your signature: chosen design, your changes, the merged details, sync mode and connected computers' })
  mine() {
    return this.signatures.mine();
  }

  @Put('me')
  @Doc({ summary: 'Save your design, your changes and (if your company allows it) how your computers keep it up to date', body: saveSignatureInput })
  save(@Body(new ZodPipe(saveSignatureInput)) body: SaveSignatureInput) {
    return this.signatures.saveMine(body);
  }

  @Post('me/sync-request')
  @HttpCode(200)
  @Doc({ summary: 'Ask your computers to install the signature again at their next check' })
  requestSync() {
    return this.signatures.requestSync();
  }

  @Post('me/agents')
  @Doc({ summary: 'Connect a Windows computer: returns its setup file once (it contains the computer\'s own token)', body: agentNameInput })
  addAgent(@Body(new ZodPipe(agentNameInput)) body: z.infer<typeof agentNameInput>) {
    return this.signatures.addAgent(body.name);
  }

  @Delete('me/agents/:id')
  @HttpCode(204)
  @Doc({ summary: 'Disconnect one of your computers' })
  async revokeMine(@Param('id', UuidPipe) id: string) {
    await this.signatures.revokeMine(id);
  }

  @Get('logo')
  @Doc({ summary: 'The company logo used in signatures' })
  async logo(@Res() res: Response) {
    sendFile(res, await this.signatures.openLogo());
  }

  @Get('settings')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Company signature settings' })
  settings() {
    return this.signatures.settings();
  }

  @Put('settings')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Save the company signature settings', body: signatureSettingsInput })
  saveSettings(@Body(new ZodPipe(signatureSettingsInput)) body: SignatureSettingsInput) {
    return this.signatures.saveSettings(body);
  }

  @Put('settings/logo')
  @RequirePermission('org:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Set the company logo for signatures (multipart/form-data: file). PNG or JPEG up to 1 MB.' })
  setLogo(@UploadedFile() file?: { mimetype: string; size: number; buffer: Buffer }) {
    return this.signatures.setLogo(file);
  }

  @Delete('settings/logo')
  @HttpCode(204)
  @RequirePermission('org:manage')
  @Doc({ summary: 'Remove the company logo from signatures' })
  async removeLogo() {
    await this.signatures.removeLogo();
  }

  @Get('overview')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Everyone\'s signature design and connected computers, with their last sync' })
  overview() {
    return this.signatures.overview();
  }

  @Get('banners')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Company festival, celebration and custom banners for signatures' })
  banners() {
    return this.signatures.banners();
  }

  @Post('banners')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Add a festival from the library (in your own words) or a custom banner with its own dates', body: signatureBannerInput })
  createBanner(@Body(new ZodPipe(signatureBannerInput)) body: SignatureBannerInput) {
    return this.signatures.createBanner(body);
  }

  @Put('banners/:id')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Change a banner', body: signatureBannerInput })
  updateBanner(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(signatureBannerInput)) body: SignatureBannerInput) {
    return this.signatures.updateBanner(id, body);
  }

  @Delete('banners/:id')
  @HttpCode(204)
  @RequirePermission('org:manage')
  @Doc({ summary: 'Delete a banner' })
  async deleteBanner(@Param('id', UuidPipe) id: string) {
    await this.signatures.deleteBanner(id);
  }

  @Put('banners/:id/image')
  @RequirePermission('org:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Set a banner image (multipart/form-data: file). PNG, JPEG or GIF up to 1 MB.' })
  setBannerImage(@Param('id', UuidPipe) id: string, @UploadedFile() file?: { mimetype: string; size: number; buffer: Buffer }) {
    return this.signatures.setBannerImage(id, file);
  }

  @Delete('banners/:id/image')
  @HttpCode(204)
  @RequirePermission('org:manage')
  @Doc({ summary: 'Remove a banner image (the banner shows as a coloured strip instead)' })
  async removeBannerImage(@Param('id', UuidPipe) id: string) {
    await this.signatures.removeBannerImage(id);
  }

  @Get('banners/:id/image')
  @Doc({ summary: 'A banner image, for the signature preview' })
  async bannerImage(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    sendFile(res, await this.signatures.openBannerImage(id));
  }

  @Delete('agents/:id')
  @HttpCode(204)
  @RequirePermission('org:manage')
  @Doc({ summary: 'Disconnect anyone\'s computer' })
  async revoke(@Param('id', UuidPipe) id: string) {
    await this.signatures.adminRevokeAgent(id);
  }
}

/**
 * The Windows signature sync. Each computer is identified by its own token (in its setup file), sent as a Bearer
 * token. It can only read its owner's signature and images and report what it wrote.
 */
@Controller('signature-agent')
@Public()
export class SignatureAgentController {
  constructor(private readonly signatures: SignaturesService) {}

  @Post('sync')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Doc({ summary: 'The signature for this computer, unless it already has the current version', body: signatureAgentSyncInput })
  sync(@Headers('authorization') authorization: string | undefined, @Body(new ZodPipe(signatureAgentSyncInput)) body: z.infer<typeof signatureAgentSyncInput>, @Req() req: { ip?: string }) {
    return this.signatures.agentSync(authorization, body, req.ip ?? null);
  }

  @Post('report')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Doc({ summary: 'Tell SampCrew whether the signature was written to Outlook', body: signatureAgentReport })
  report(@Headers('authorization') authorization: string | undefined, @Body(new ZodPipe(signatureAgentReport)) body: z.infer<typeof signatureAgentReport>) {
    return this.signatures.agentReport(authorization, body);
  }

  @Get('images/:kind')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Doc({ summary: 'The photo or logo for this computer\'s signature' })
  async image(@Headers('authorization') authorization: string | undefined, @Param('kind', new ZodPipe(z.enum(['photo', 'logo', 'banner']))) kind: 'photo' | 'logo' | 'banner', @Res() res: Response) {
    sendFile(res, await this.signatures.agentImage(authorization, kind));
  }
}
