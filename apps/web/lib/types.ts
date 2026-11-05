import type { MeResponse } from '@crew/contracts';

export type Me = MeResponse;

export interface Member {
  id: string;
  status: string;
  title: string | null;
  userId: string;
  fullName: string;
  email: string;
  mfaEnabled: boolean;
  legalEntityId: string | null;
  legalEntityName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  managerMembershipId: string | null;
  managerName: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
  roles: { key: string; name: string; constraints: Record<string, string[]> }[];
}

export interface LegalEntity { id: string; name: string; legalName: string | null; countryCode: string; currency: string; timezone: string; registrationNumber: string | null; taxId: string | null; fiscalYearStartMonth: number; address: string | null }
export interface BusinessUnit { id: string; name: string; code: string | null; description: string | null }
export interface Location { id: string; name: string; code: string | null; kind: string; legalEntityId: string; timezone: string; city: string | null; region: string | null; countryCode: string; latitude: number | null; longitude: number | null; geofenceRadiusM: number | null; addressLine: string | null; postalCode: string | null }
export interface Department { id: string; name: string; code: string | null; parentId: string | null; legalEntityId: string | null; businessUnitId: string | null; headMembershipId: string | null; memberCount: number; children?: Department[] }
export interface Role { id: string; key: string; name: string; description: string | null; isSystem: boolean; memberCount: number; grants: Record<string, string> }
export interface Page<T> { items: T[]; nextCursor: string | null }
