export interface PortalCase {
  workspace: string | null;
  agency: string | null;
  reference: string;
  status: string;
  closed: boolean;
  employee: { name: string; dateOfJoining: string | null };
  dueDate: string | null;
  expiresAt: string;
  submittedAt: string | null;
  checks: { id: string; type: string; label: string; status: string; details: Record<string, string>; agencyFeedback: string | null }[];
  files: { id: string; title: string; kind: string; fileName: string; sizeBytes: number }[];
}
