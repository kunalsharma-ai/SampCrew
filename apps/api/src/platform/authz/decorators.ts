import { SetMetadata } from '@nestjs/common';
import type { BooleanFeatureKey, PermissionKey } from '@crew/contracts';

export const PUBLIC_KEY = 'crew:public';
export const PERMISSION_KEY = 'crew:permission';
export const FEATURE_KEY = 'crew:feature';
export const REALM_KEY = 'crew:realm';
export const ALLOW_WITHOUT_MFA_KEY = 'crew:allow-without-mfa';
export const ROOT_PATH_KEY = 'crew:root-path';
export const ALLOW_WHEN_LOCKED_KEY = 'crew:allow-when-locked';

/** No authentication required (login, signup, health, public career pages). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Route-level RBAC check. Record-level ABAC checks happen in services via AuthzService.require(perm, resource). */
export const RequirePermission = (permission: PermissionKey) => SetMetadata(PERMISSION_KEY, permission);

/** Subscription entitlement gate. */
export const RequireFeature = (feature: BooleanFeatureKey) => SetMetadata(FEATURE_KEY, feature);

/** Routes for the SAMPLEDGE Super Admin Console use the separate platform realm and tokens. */
export const PlatformRealm = (capability?: string) => SetMetadata(REALM_KEY, { realm: 'platform', capability });

/** Reachable even when the workspace or platform policy requires MFA and the session has not completed it (for enrolment). */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA_KEY, true);

/** Served at the server root instead of under /api/v1 (device protocols with fixed paths). */
export const RootPath = () => SetMetadata(ROOT_PATH_KEY, true);

/** SCIM provisioning routes: a workspace SCIM token, not a user session. */
export const ScimRealm = () => SetMetadata(REALM_KEY, { realm: 'scim' });

/**
 * Usable while the workspace is read-only for an unpaid invoice: changes here are allowed (paying, signing out,
 * the person's own password and two-step verification). Everywhere else only reading is.
 */
export const AllowWhenLocked = () => SetMetadata(ALLOW_WHEN_LOCKED_KEY, true);
