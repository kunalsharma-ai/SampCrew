import { Injectable } from '@nestjs/common';
import { consoleSettingsInput, DEFAULT_CONSOLE_SETTINGS, type ConsoleSettings } from '@crew/contracts';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

type Section = keyof ConsoleSettings;
const SECTIONS = Object.keys(DEFAULT_CONSOLE_SETTINGS) as Section[];

/**
 * Console global settings (platform_settings, one row per section). Each value is used where it applies: trial
 * length and owner access for new companies, session length and lockout for Console sign-in, renewal notices and
 * inactivity for the command center. A missing or damaged row falls back to the default for that section.
 */
@Injectable()
export class ConsoleSettingsService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  get(): Promise<ConsoleSettings> {
    return this.db.platform((tx) => this.read(tx));
  }

  async read(tx: PlatformTx): Promise<ConsoleSettings> {
    const rows = await tx.collection<{ key: string; value: unknown }>('platform_settings').find({ key: { $in: SECTIONS } });
    const out = structuredClone(DEFAULT_CONSOLE_SETTINGS) as Record<Section, unknown>;
    for (const r of rows) {
      const shape = consoleSettingsInput.shape[r.key as Section];
      const parsed = shape?.safeParse({ ...(DEFAULT_CONSOLE_SETTINGS[r.key as Section] as object), ...(r.value as object) });
      if (parsed?.success) out[r.key as Section] = parsed.data;
    }
    return out as ConsoleSettings;
  }

  /** Saves one or more sections; every change is audited with the values before and after. */
  update(input: Partial<ConsoleSettings>): Promise<ConsoleSettings> {
    const admin = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const before = await this.read(tx);
      if (input.workspaceDefaults?.defaultPlan && !(await tx.collection('plans').exists({ key: input.workspaceDefaults.defaultPlan, archived_at: null, retired_at: null }))) {
        throw Errors.badRequest('unknown_plan', 'Pick an active plan as the default');
      }
      const changes: Record<string, unknown> = {};
      for (const key of SECTIONS) {
        const value = input[key];
        if (!value) continue;
        const d = diff(before[key] as Record<string, unknown>, value as Record<string, unknown>);
        if (!Object.keys(d).length) continue;
        changes[key] = d;
        await tx.collection('platform_settings').upsert({ key }, { key, value, updated_by_admin_id: admin.adminId }, { $set: { value, updated_by_admin_id: admin.adminId } });
      }
      if (Object.keys(changes).length) await this.audit.record(tx, { tenantId: null, action: 'platform.settings_updated', resourceType: 'platform_settings', resourceId: null, changes });
      return this.read(tx);
    });
  }
}
