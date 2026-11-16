import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { FirstAdminRequest } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, hashPassword, safeEqual } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

/** Letters and digits that cannot be mistaken for each other when read from a log. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

function newCode(): string {
  const raw = Array.from(randomBytes(15), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`;
}

/**
 * First-run setup of a new installation, so the first SAMPLEDGE Super admin needs no password in the server's
 * settings file. While no Console admin exists, the API keeps a one-time setup code in the database (instance_secrets,
 * encrypted) and prints it in its log on every start. Whoever runs the server reads it there, opens the Console, which
 * shows the setup page instead of sign-in, and creates the first Super admin with it; two-step verification is then
 * set up at the first sign-in like for every admin. The code is deleted at once and the page is gone for good.
 *
 * The code is 15 random characters (75 bits) and the endpoint allows 5 tries a minute, so it cannot be guessed; the
 * Console is also only reachable from the addresses in CONSOLE_ALLOWED_IPS. (CREW_BOOTSTRAP_ADMIN_EMAIL/_PASSWORD
 * still work for automated installs and tests: `pnpm db:seed` creates that admin before anyone opens the Console.)
 */
@Injectable()
export class FirstRunService implements OnApplicationBootstrap {
  private readonly log = new Logger('FirstRun');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap() {
    const code = await this.setupCode();
    if (code) {
      this.log.warn(`SampCrew is not set up yet. Open the Super Admin Console and create the first Super admin with this one-time setup code: ${code}`);
    }
  }

  async status(): Promise<{ needsFirstAdmin: boolean }> {
    return { needsFirstAdmin: !(await this.hasAdmin()) };
  }

  /** The setup code while no admin exists (creating it the first time), else null. */
  async setupCode(): Promise<string | null> {
    if (await this.hasAdmin()) return null;
    const readOrCreate = () => this.db.platform(async (tx) => {
      const secrets = tx.collection<{ key: string; value_enc: string }>('instance_secrets');
      const row = (await secrets.findOne({ key: 'setup_code' })) ?? (await secrets.insert({ key: 'setup_code', value_enc: encryptField(newCode(), this.config.fieldKeys), origin: 'generated' }));
      return decryptField(row.value_enc, this.config.fieldKeys);
    });
    // Two API servers starting together: the second one's insert fails, and it reads the first one's code.
    return readOrCreate().catch(() => readOrCreate());
  }

  async createFirstAdmin(input: FirstAdminRequest): Promise<{ email: string }> {
    const passwordHash = await hashPassword(input.password);
    await this.db.platform(async (tx) => {
      const secrets = tx.collection<{ key: string; value_enc: string }>('instance_secrets');
      // Serialises two people submitting at once: the second finds an admin and no code.
      await secrets.lock({ key: 'setup_code' });
      const admins = tx.collection('platform_admins');
      if (await admins.exists({})) throw Errors.conflict('already_set_up', 'SampCrew is already set up. Sign in instead.');
      const row = await secrets.findOne({ key: 'setup_code' });
      const expected = row ? normalise(decryptField(row.value_enc, this.config.fieldKeys)) : '';
      if (!expected || !safeEqual(normalise(input.setupCode), expected)) {
        throw Errors.validation([{ path: 'setupCode', message: 'That setup code is not right. Copy it from the API\'s log (the line "SampCrew is not set up yet")' }]);
      }
      const admin = await admins.insert({ email: input.email, full_name: input.fullName, password_hash: passwordHash, role: 'super_admin', must_change_password: false });
      await secrets.deleteOne({ key: 'setup_code' });
      await this.audit.record(tx, {
        tenantId: null, action: 'platform.first_admin_created', resourceType: 'platform_admin', resourceId: admin.id as string,
        actorLabel: `first-run setup (${input.email})`, changes: { email: input.email, role: 'super_admin' },
      });
    });
    this.log.log(`First Super admin ${input.email} created with the setup code; the setup page is closed.`);
    return { email: input.email };
  }

  private hasAdmin(): Promise<boolean> {
    return this.db.platform((tx) => tx.collection('platform_admins').exists({}));
  }
}
