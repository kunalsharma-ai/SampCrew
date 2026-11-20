// Renders docs/architecture/05-roles-and-permissions.md from the permission catalogue.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PERMISSIONS, SYSTEM_ROLES, PLATFORM_ROLE_CAPABILITIES, SCOPES, ACCESS_LEVEL_ROLES, LEGACY_ROLE_LEVEL } = require('../dist/index.js');

const abbrev = { own: 'O', team: 'T', department: 'D', entity: 'E', tenant: 'A' };
// Only the access levels give access; the roles from before them stay in the database for rollback and are listed in 5.4.
const roles = SYSTEM_ROLES.filter((r) => ACCESS_LEVEL_ROLES.includes(r.key));
const legacy = SYSTEM_ROLES.filter((r) => !ACCESS_LEVEL_ROLES.includes(r.key));
const out = [];
out.push('# 5. User Role and Permission Matrix', '');
out.push('> Generated from `packages/contracts/src/permissions.ts` and `roles.ts` by `pnpm docs:permissions`. Do not edit by hand.', '');
out.push('## 5.1 Model', '');
out.push('SampCrew has four access levels: **Console Admin** (SAMPLEDGE, in the Console) > **Super Workspace** > **HR Workspace** > **Employee Workspace**. Each level gives only part of what the level above it has, and the API enforces it. Designations, departments and job titles never give access.', '');
out.push('Within the company, access combines **RBAC** (the level bundles permissions) with **ABAC** (each grant carries a scope, the level assignment can carry limits, and environmental conditions such as MFA apply):', '');
out.push('- **Permission**: `resource:action`, for example `leave:approve`.');
out.push('- **Scope** (which records the grant covers):');
out.push('  - `O` own: records about the member themself.');
out.push('  - `T` team: the member and everyone who reports to them, directly or indirectly.');
out.push('  - `D` department: the member\'s department and all of its sub-departments.');
out.push('  - `E` entity: the member\'s legal entity.');
out.push('  - `A` all: the whole tenant.');
out.push('- **Level limits**: an HR Workspace assignment can be narrowed to named HR Workspaces, legal entities, departments or locations, and to chosen areas (modules) in full or view only. People moved from the old roles keep their exact previous permissions as kept grants.');
out.push('- **Employee Workspace**: everyone holds it. Team permissions apply only to people with someone reporting to them.');
out.push('- **Environmental conditions**: permissions marked MFA require a session that completed multi-factor authentication. Sensitive permissions are additionally audited on every read.');
out.push('- **No custom roles**: the access levels replace custom roles. A member\'s effective permission is the widest scope across their levels, within their limits.');
out.push('- **Tenant isolation is not a permission.** No role in a tenant can see another tenant; that is enforced by the data layer\'s workspace transactions underneath every permission check.', '');
out.push('## 5.2 Access levels × permissions', '');
out.push('| Permission | Phase | MFA | ' + roles.map((r) => r.name).join(' | ') + ' |');
out.push('|---|---|---|' + roles.map(() => '---').join('|') + '|');
let module = '';
for (const p of PERMISSIONS) {
  if (p.module !== module) {
    module = p.module;
    out.push(`| **${module}** | | | ` + roles.map(() => '').join(' | ') + ' |');
  }
  const cells = roles.map((r) => (r.grants[p.key] ? abbrev[r.grants[p.key]] : '·'));
  out.push(`| \`${p.key}\` ${p.description} | ${p.phase} | ${p.requiresMfa ? 'yes' : ''} | ${cells.join(' | ')} |`);
}
out.push('', 'Legend: O own, T team, D department, E legal entity, A all (tenant), · not granted.', '');
out.push('## 5.3 Level descriptions', '');
for (const r of roles) out.push(`- **${r.name}** (\`${r.key}\`): ${r.description}`);
out.push('', '## 5.4 Roles from before the access levels (kept for rollback, give no access)', '');
out.push('The migration moved each person to the level below, with their exact previous permissions kept as limits. `pnpm db:migrate` runs it; the per-company rollback restores the old assignments from `access_level_migrations`.', '');
for (const r of legacy) out.push(`- ${r.name} (\`${r.key}\`): ${r.key === 'tenant_owner' || r.key === 'org_admin' ? 'Super Workspace' : LEGACY_ROLE_LEVEL[r.key] === 'hr' ? 'HR Workspace' : 'Employee Workspace'}`);
out.push('', '## 5.5 Console Admin (SAMPLEDGE Console)', '');
out.push('Platform staff authenticate in a separate realm (`platform_admins` table, separate login, MFA mandatory). They have **no** access to tenant data by default. Viewing a tenant\'s data requires a time-boxed support access grant that the tenant owner approves, and every action is written to both the platform audit log and the tenant\'s own audit log.', '');
out.push('| Capability | ' + Object.keys(PLATFORM_ROLE_CAPABILITIES).join(' | ') + ' |');
out.push('|---|' + Object.keys(PLATFORM_ROLE_CAPABILITIES).map(() => '---').join('|') + '|');
const caps = [...new Set(Object.values(PLATFORM_ROLE_CAPABILITIES).flat())];
for (const c of caps) out.push(`| \`${c}\` | ` + Object.values(PLATFORM_ROLE_CAPABILITIES).map((list) => (list.includes(c) ? '✓' : '·')).join(' | ') + ' |');
out.push('');
void SCOPES;
process.stdout.write(out.join('\n'));
