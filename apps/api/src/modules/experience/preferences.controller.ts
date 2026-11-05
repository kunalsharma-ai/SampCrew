import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  MAX_RECENTS, appearancePatch, dashboardLayoutInput, favouritesInput, normaliseAppearance, notesInput, recentVisitInput, resolveLayout,
  type MemberPreferences,
} from '@crew/contracts';
import { z } from 'zod';
import { AllowWithoutMfa } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, one, type Tx } from '../../platform/database/database.service';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

interface Row { appearance: unknown; favourites: string[]; recents: { href: string; label: string; at: string }[]; dashboard: unknown; notes: string; updated_at: string | null }

const SELECT = 'select appearance, favourites, recents, dashboard, notes, updated_at from member_preferences where membership_id = $1';

function shape(r: Row | undefined): MemberPreferences {
  return {
    appearance: normaliseAppearance(r?.appearance),
    favourites: r?.favourites ?? [],
    recents: Array.isArray(r?.recents) ? r!.recents : [],
    dashboard: resolveLayout(r?.dashboard as never),
    notes: r?.notes ?? '',
    updatedAt: r?.updated_at ?? null,
  };
}

/**
 * The signed-in member's own workspace experience: theme and accessibility preferences, favourite and recent pages,
 * Home layout and personal notes. Every member can read and change only their own row, so no permission is needed.
 */
@Controller('me/preferences')
export class PreferencesController {
  constructor(private readonly db: DatabaseService) {}

  private async upsert(tx: Tx, column: 'appearance' | 'favourites' | 'recents' | 'dashboard' | 'notes', value: unknown) {
    const me = requestContext.tenantActor();
    await tx.query(
      `insert into member_preferences (tenant_id, membership_id, ${column}) values (app_tenant_id(), $1, $2)
       on conflict (tenant_id, membership_id) do update set ${column} = excluded.${column}`,
      [me.membershipId, value],
    );
    return shape(await one<Row>(tx, SELECT, [me.membershipId]));
  }

  @Get()
  @AllowWithoutMfa()
  @Doc({ summary: 'Your appearance, favourite and recent pages, Home layout and notes' })
  get() {
    const me = requestContext.tenantActor();
    return this.db.tenant(async (tx) => shape(await one<Row>(tx, SELECT, [me.membershipId])));
  }

  @Put('appearance')
  @AllowWithoutMfa()
  @Doc({ summary: 'Change any of your appearance settings (theme preset, mode, colours, density, motion, focus mode)', body: appearancePatch })
  appearance(@Body(new ZodPipe(appearancePatch)) body: z.infer<typeof appearancePatch>) {
    const me = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const current = shape(await one<Row>(tx, SELECT, [me.membershipId])).appearance;
      return this.upsert(tx, 'appearance', normaliseAppearance({ ...current, ...body }));
    });
  }

  @Post('appearance/reset')
  @AllowWithoutMfa()
  @HttpCode(200)
  @Doc({ summary: 'Go back to the default appearance' })
  reset() {
    return this.db.tenant((tx) => this.upsert(tx, 'appearance', {}));
  }

  @Put('favourites')
  @Doc({ summary: 'Replace your favourite pages (up to 12, in order)', body: favouritesInput })
  favourites(@Body(new ZodPipe(favouritesInput)) body: z.infer<typeof favouritesInput>) {
    return this.db.tenant((tx) => this.upsert(tx, 'favourites', [...new Set(body.hrefs)]));
  }

  @Post('recents')
  @HttpCode(200)
  @Doc({ summary: 'Record a page you opened; keeps your last 8 distinct pages', body: recentVisitInput })
  recent(@Body(new ZodPipe(recentVisitInput)) body: z.infer<typeof recentVisitInput>) {
    const me = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const current = shape(await one<Row>(tx, `${SELECT} for update`, [me.membershipId])).recents;
      const next = [{ href: body.href, label: body.label, at: new Date().toISOString() }, ...current.filter((r) => r.href !== body.href)].slice(0, MAX_RECENTS);
      return this.upsert(tx, 'recents', JSON.stringify(next));
    });
  }

  @Put('dashboard')
  @Doc({ summary: 'Save your Home widget order and hidden widgets', body: dashboardLayoutInput })
  dashboard(@Body(new ZodPipe(dashboardLayoutInput)) body: z.infer<typeof dashboardLayoutInput>) {
    return this.db.tenant((tx) => this.upsert(tx, 'dashboard', resolveLayout(body)));
  }

  @Put('notes')
  @Doc({ summary: 'Save your personal notes (only you can see them)', body: notesInput })
  notes(@Body(new ZodPipe(notesInput)) body: z.infer<typeof notesInput>) {
    return this.db.tenant((tx) => this.upsert(tx, 'notes', body.notes));
  }
}
