import { SetMetadata } from '@nestjs/common';
import type { BooleanFeatureKey, PermissionKey } from '@crew/contracts';

export const PUBLIC_KEY = 'crew:public';
export const PERMISSION_KEY = 'crew:permission';
export const FEATURE_KEY = 'crew:feature';
export const REALM_KEY = 'crew:realm';
export const ALLOW_WITHOUT_MFA_KEY = 'crew:allow-without-mfa';

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
