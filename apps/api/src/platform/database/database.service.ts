import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow, types } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { requestContext } from '../context/request-context';

export type Tx = PoolClient;

// SQL `date` has no time zone; keep it as the YYYY-MM-DD string instead of a local-midnight JS Date.
types.setTypeParser(1082, (v) => v);

/**
 * All data access goes through one of three transaction kinds:
 *
 *  - tenant(): SET LOCAL ROLE crew_app + app.tenant_id/app.user_id. PostgreSQL Row-Level Security confines
 *    every statement to the current tenant, so even a buggy query cannot read another tenant's rows.
 *  - user():   crew_app with only app.user_id, for pre-tenant flows such as listing a user's own workspaces.
 *  - platform(): SET LOCAL ROLE crew_platform (BYPASSRLS). Only for authentication bootstrap and the
 *    SAMPLEDGE Super Admin Console. Call sites are few and reviewed.
 *
 * The API's login role (crew_api) holds no table privileges itself, so a query outside these wrappers fails.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger('Database');
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, application_name: 'crew-api' });
    this.pool.on('error', (err) => this.logger.error(`Idle client error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /** Runs fn in a tenant-scoped transaction for the current request's actor (or an explicit tenant for workers). */
  tenant<T>(fn: (tx: Tx) => Promise<T>, scope?: { tenantId: string; userId?: string }): Promise<T> {
    const actor = requestContext.get()?.actor;
    const tenantId = scope?.tenantId ?? (actor?.kind === 'user' ? actor.tenantId : undefined);
    const userId = scope?.userId ?? (actor?.kind === 'user' ? actor.userId : undefined);
    if (!tenantId) throw new Error('tenant() called without a tenant in context');
    return this.run('crew_app', { 'app.tenant_id': tenantId, 'app.user_id': userId ?? '' }, fn);
  }

  user<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run('crew_app', { 'app.user_id': userId, 'app.tenant_id': '' }, fn);
  }

  platform<T>(fn: (tx: Tx) => Promise<T>, settings: Record<string, string> = {}): Promise<T> {
    return this.run('crew_platform', settings, fn);
  }

  private async run<T>(role: 'crew_app' | 'crew_platform', settings: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      for (const [k, v] of Object.entries(settings)) {
        await client.query('select set_config($1, $2, true)', [k, v]);
      }
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function one<T extends QueryResultRow>(tx: Tx, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await tx.query<T>(sql, params)).rows[0];
}

export async function many<T extends QueryResultRow>(tx: Tx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}
