import type { SignatureBase, SignatureOptions, SignatureSyncMode, SignatureTemplateKey, SocialNetwork } from '@crew/contracts';

export interface SignatureAgent {
  id: string; name: string; tokenHint: string; computerName: string | null; outlookVersions: string[] | null; agentVersion: string | null;
  createdAt: string; lastSeenAt: string | null; lastTrigger: string | null; lastAppliedVersion: string | null; lastAppliedAt: string | null; lastError: string | null;
  upToDate?: boolean;
}

export interface CompanySignature {
  companyName: string | null; website: string | null; phone: string | null; address: string | null; brandColor: string; accentColor: string;
  defaultTemplate: SignatureTemplateKey; disclaimer: string | null; social: Partial<Record<SocialNetwork, string>>; syncMode: SignatureSyncMode;
  allowEmployeeSyncChoice: boolean; lockTemplate: boolean; logo: { updatedAt: string; width: number | null; height: number | null } | null; updatedAt: string | null;
}

export interface MySignature {
  employeeId: string; saved: boolean; template: SignatureTemplateKey; options: SignatureOptions; syncMode: SignatureSyncMode; ownSyncMode: SignatureSyncMode | null;
  syncRequestedAt: string | null; updatedAt: string | null; base: SignatureBase; canUsePhoto: boolean; canUseLogo: boolean; photoUpdatedAt: string | null;
  photoNotForOutlook: boolean; version: string; company: CompanySignature; agents: SignatureAgent[];
}

/** Image addresses for the preview in SampCrew (Outlook gets the same images as files next to the signature). */
export function previewImages(s: Pick<MySignature, 'employeeId' | 'canUsePhoto' | 'canUseLogo' | 'photoUpdatedAt' | 'company'>, show: { photo: boolean; logo: boolean }) {
  return {
    photoSrc: s.canUsePhoto && show.photo ? `/employee-photos/${s.employeeId}?v=${encodeURIComponent(new Date(s.photoUpdatedAt ?? 0).getTime())}` : null,
    logoSrc: s.canUseLogo && show.logo && s.company.logo ? `/signature-logo?v=${encodeURIComponent(new Date(s.company.logo.updatedAt).getTime())}` : null,
  };
}
