import { Injectable } from '@nestjs/common';
import { builtInStatutoryPacks, type StatutoryPackInput, statutorySchemeProblem } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx as Tx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

interface PackRow {
  id: string; country_code: string; country: string; currency: string; basis: string; summary: string; settings: unknown; active: boolean; built_in: boolean;
  customised_at: Date | null; customised_by_admin_id: string | null; updated_at: Date;
}

/**
 * Statutory country packs in the database (collection statutory_packs). Workspaces take the starting values for a
 * legal entity's statutory settings from here. SampCrew's built-in packs are copied in on every deploy until
 * SAMPLEDGE customises one; SAMPLEDGE can also add a pack for any other country, or switch one off.
 * Changing a pack never changes settings a workspace has already saved.
 */
@Injectable()
export class StatutoryPacksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.db.platform(async (tx) => {
      const rows = await tx.collection<PackRow>('statutory_packs').find({}, { sort: { country: 1 } });
      const admins = new Map((await tx.collection<{ id: string; full_name: string }>('platform_admins').find({ id: { $in: rows.map((r) => r.customised_by_admin_id).filter(Boolean) } })).map((a) => [a.id, a.full_name]));
      return rows
        .map((r) => ({
          countryCode: r.country_code, country: r.country, currency: r.currency, basis: r.basis, summary: r.summary ?? '', settings: r.settings, active: r.active, builtIn: r.built_in,
          customisedAt: r.customised_at ?? null, customisedBy: (r.customised_by_admin_id && admins.get(r.customised_by_admin_id)) ?? null, updatedAt: r.updated_at,
        }))
        .sort((a, b) => Number(b.countryCode === 'IN') - Number(a.countryCode === 'IN'));
    });
  }

  /** Creates or replaces the pack of a country. */
  save(countryCode: string, input: StatutoryPackInput) {
    const actor = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const problem = statutorySchemeProblem(input.settings, countryCode);
      if (problem) throw Errors.badRequest(problem.code, problem.message);
      const packs = tx.collection<PackRow>('statutory_packs');
      const existing = await packs.findOne({ country_code: countryCode });
      const fields = {
        country: input.country, currency: input.currency, basis: input.basis, summary: input.summary ?? '', settings: input.settings, active: input.active,
        customised_at: new Date(), customised_by_admin_id: actor.adminId,
      };
      if (existing) await packs.updateOne({ id: existing.id }, { $set: fields });
      else await packs.insert({ country_code: countryCode, built_in: false, ...fields });
      await this.audit.record(tx, {
        tenantId: null, action: existing ? 'platform.statutory_pack_updated' : 'platform.statutory_pack_created', resourceType: 'statutory_pack', resourceId: countryCode,
        changes: { ...input },
      });
      return { countryCode, created: !existing };
    });
  }

  /** Puts a built-in pack back to SampCrew's values; later deploys keep it in line with the code again. */
  reset(countryCode: string) {
    return this.db.platform(async (tx) => {
      const builtIn = builtInStatutoryPacks().find((p) => p.countryCode === countryCode);
      if (!builtIn) throw Errors.badRequest('not_built_in', 'Only a pack that comes with SampCrew can be reset. Remove a pack you added instead.');
      const packs = tx.collection<PackRow>('statutory_packs');
      const fields = { country: builtIn.country, currency: builtIn.currency, basis: builtIn.basis, summary: builtIn.summary, settings: builtIn.settings, active: true, built_in: true, customised_at: null, customised_by_admin_id: null };
      const existing = await packs.findOne({ country_code: countryCode });
      if (existing) await packs.updateOne({ id: existing.id }, { $set: fields });
      else await packs.insert({ country_code: countryCode, ...fields });
      await this.audit.record(tx, { tenantId: null, action: 'platform.statutory_pack_reset', resourceType: 'statutory_pack', resourceId: countryCode });
      return { countryCode };
    });
  }

  /** Removes a pack SAMPLEDGE added. A built-in pack is switched off instead (it would come back on the next deploy). */
  remove(countryCode: string) {
    return this.db.platform(async (tx) => {
      const pack = await this.pack(tx, countryCode);
      if (pack.built_in) throw Errors.conflict('built_in', 'This pack comes with SampCrew. Switch it off instead of removing it.');
      await tx.collection('statutory_packs').deleteOne({ id: pack.id });
      await this.audit.record(tx, { tenantId: null, action: 'platform.statutory_pack_removed', resourceType: 'statutory_pack', resourceId: countryCode });
    });
  }

  private async pack(tx: Tx, countryCode: string) {
    const p = await tx.collection<PackRow>('statutory_packs').findOne({ country_code: countryCode });
    if (!p) throw Errors.notFound('Statutory pack');
    return p;
  }
}
