import { FEATURES, PLAN_TEMPLATES } from '@crew/contracts';
import type { Pool, PoolClient } from 'pg';

/**
 * Upserts the feature catalogue and default plans. Safe to run on every deploy.
 * Prices are only inserted when missing so that changes made in the Super Admin Console are kept.
 */
export async function syncCatalogue(db: Pool | PoolClient): Promise<void> {
  for (const f of FEATURES) {
    await db.query(
      `insert into features (key, name, module, kind, unit) values ($1, $2, $3, $4, $5)
       on conflict (key) do update set name = excluded.name, module = excluded.module, kind = excluded.kind, unit = excluded.unit`,
      [f.key, f.name, f.module, f.kind, 'unit' in f ? f.unit : null],
    );
  }
  for (const p of PLAN_TEMPLATES) {
    const { rows } = await db.query<{ id: string }>(
      `insert into plans (key, name, tagline, sort_order, minimum_seats, quote_only) values ($1, $2, $3, $4, $5, $6)
       on conflict (key) do update set name = excluded.name, tagline = excluded.tagline, sort_order = excluded.sort_order,
         minimum_seats = excluded.minimum_seats, quote_only = excluded.quote_only
       returning id`,
      [p.key, p.name, p.tagline, p.sortOrder, p.minimumSeats, p.quoteOnly],
    );
    const planId = rows[0]!.id;
    for (const price of p.prices) {
      await db.query(
        `insert into plan_prices (plan_id, currency, monthly_per_seat, annual_per_seat_month) values ($1, $2, $3, $4)
         on conflict (plan_id, currency) do nothing`,
        [planId, price.currency, price.monthly, price.annualPerMonth],
      );
    }
    await db.query('delete from plan_features where plan_id = $1', [planId]);
    for (const key of p.features) {
      await db.query('insert into plan_features (plan_id, feature_key) values ($1, $2)', [planId, key]);
    }
    for (const [key, value] of Object.entries(p.limits)) {
      await db.query('insert into plan_features (plan_id, feature_key, limit_value) values ($1, $2, $3)', [planId, key, value]);
    }
  }
}
