import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { deviceRegisterInput, type DeviceRegisterInput, punchSyncInput, type PunchSyncInput, pushTokenInput } from '@crew/contracts';
import type { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AttendanceService } from '../attendance/attendance.service';
import { MobileService } from './mobile.service';

/** Devices are personal: every route acts on the caller's own devices only. */
@Controller('mobile')
@RequireFeature('self_service')
export class MobileController {
  constructor(
    private readonly mobile: MobileService,
    private readonly attendance: AttendanceService,
  ) {}

  @Post('devices')
  @HttpCode(200)
  @Doc({ summary: 'Register this phone after sign-in (idempotent per installation id)', body: deviceRegisterInput })
  register(@Body(new ZodPipe(deviceRegisterInput)) body: DeviceRegisterInput) {
    return this.mobile.register(body);
  }

  @Get('devices')
  @Doc({ summary: 'My signed-in devices' })
  list() {
    return this.mobile.list();
  }

  @Put('devices/:id/push-token')
  @Doc({ summary: 'Turn push on (Expo push token) or off (null) for one of my devices', body: pushTokenInput })
  pushToken(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(pushTokenInput)) body: z.infer<typeof pushTokenInput>) {
    return this.mobile.setPushToken(id, body.token);
  }

  @Post('devices/:id/sign-out')
  @HttpCode(204)
  @Doc({ summary: 'Sign a device out: ends its sign-in, removes its push token and refuses its queued punches' })
  async revoke(@Param('id', UuidPipe) id: string) {
    await this.mobile.revoke(id);
  }

  @Post('punches')
  @HttpCode(200)
  @RequireFeature('attendance_basic')
  @RequirePermission('attendance:punch')
  @Doc({
    summary: 'Send punches queued on the phone (online or after being offline)',
    description: 'Idempotent per device and sequence. Each punch is accepted (possibly with risk flags), a duplicate, or rejected with a reason.',
    body: punchSyncInput,
  })
  sync(@Body(new ZodPipe(punchSyncInput)) body: PunchSyncInput) {
    return this.attendance.syncMobile(body);
  }
}
