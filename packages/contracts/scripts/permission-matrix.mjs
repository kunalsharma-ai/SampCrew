// Renders docs/architecture/05-roles-and-permissions.md from the permission catalogue.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PERMISSIONS, SYSTEM_ROLES, PLATFORM_ROLE_CAPABILITIES, SCOPES } = require('../dist/index.js');

const abbrev = { own: 'O', team: 'T', department: 'D', entity: 'E', tenant: 'A' };
const roles = SYSTEM_ROLES;
const out = [];
out.push('# 5. User Role and Permission Matrix', '');
out.push('> Generated from `packages/contracts/src/permissions.ts` and `roles.ts` by `pnpm docs:permissions`. Do not edit by hand.', '');
out.push('## 5.1 Model', '');
out.push('CREW combines **RBAC** (roles bundle permissions) with **ABAC** (each grant carries a scope, assignments can carry constraints, and environmental conditions such as MFA apply):', '');
out.push('- **Permission**: `resource:action`, for example `leave:approve`.');
out.push('- **Scope** (which records the grant covers):');
out.push('  - `O` own: records about the member themself.');
out.push('  - `T` team: the member and everyone who reports to them, directly or indirectly.');
out.push('  - `D` department: the member\'s department and all of its sub-departments.');
out.push('  - `E` entity: the member\'s legal entity.');
out.push('  - `A` all: the whole tenant.');
out.push('- **Assignment constraints**: a role assignment can be narrowed to listed legal entities, departments or locations (for example, "HR Manager for India entity only").');
out.push('- **Environmental conditions**: permissions marked MFA require a session that completed multi-factor authentication. Sensitive permissions are additionally audited on every read.');
out.push('- **Custom roles**: tenants on plans with `custom_roles` can compose their own roles from the same catalogue. A member\'s effective permission is the widest scope across all their roles.');
out.push('- **Tenant isolation is not a permission.** No role in a tenant can see another tenant; that is enforced by PostgreSQL Row-Level Security underneath every permission check.', '');
out.push('## 5.2 Tenant roles × permissions', '');
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
out.push('## 5.3 Role descriptions', '');
for (const r of roles) out.push(`- **${r.name}** (\`${r.key}\`): ${r.description}`);
out.push('', '## 5.4 Platform roles (SAMPLEDGE Super Admin Console)', '');
out.push('Platform staff authenticate in a separate realm (`platform_admins` table, separate login, MFA mandatory). They have **no** access to tenant data by default. Viewing a tenant\'s data requires a time-boxed support access grant that the tenant owner approves, and every action is written to both the platform audit log and the tenant\'s own audit log.', '');
out.push('| Capability | ' + Object.keys(PLATFORM_ROLE_CAPABILITIES).join(' | ') + ' |');
out.push('|---|' + Object.keys(PLATFORM_ROLE_CAPABILITIES).map(() => '---').join('|') + '|');
const caps = [...new Set(Object.values(PLATFORM_ROLE_CAPABILITIES).flat())];
for (const c of caps) out.push(`| \`${c}\` | ` + Object.values(PLATFORM_ROLE_CAPABILITIES).map((list) => (list.includes(c) ? '✓' : '·')).join(' | ') + ' |');
out.push('');
void SCOPES;
process.stdout.write(out.join('\n'));
