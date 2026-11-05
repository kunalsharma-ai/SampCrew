import type { TriggerEvent, WorkflowDefinition, WorkflowStep } from '@crew/contracts';

export interface Catalogue {
  triggers: { key: TriggerEvent; label: string; fields: { key: string; label: string; type: 'text' | 'number' | 'date' | 'boolean' }[] }[];
  steps: { key: WorkflowStep['type']; label: string }[];
  ops: { key: string; label: string }[];
  roles: { key: string; name: string }[];
  courses: { id: string; title: string }[];
}

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface WorkflowRow {
  id: string; name: string; description: string; status: WorkflowStatus; statusReason: string | null; trigger: TriggerEvent; updatedAt: string;
  latestVersion: number; activeVersion: number | null; ownerName: string; runs30d: number; failedRuns: number; openRuns: number;
}

export interface WorkflowDetail {
  id: string; name: string; description: string; status: WorkflowStatus; statusReason: string | null; trigger: TriggerEvent;
  activeVersionId: string | null; ownerName: string; createdAt: string; updatedAt: string; canActivate: boolean;
  latest: { id: string; version: number; definition: WorkflowDefinition; testedAt: string | null; aiDrafted: boolean; createdAt: string; byName: string; steps: (WorkflowStep & { summary: string })[] };
  versions: { id: string; version: number; testedAt: string | null; aiDrafted: boolean; createdAt: string; byName: string }[];
}

export interface TestResult {
  runId: string; status: 'succeeded' | 'stopped' | 'failed'; outcome: string; passed: boolean;
  steps: { index: number; stepId: string; type: string; status: string; detail: string; error: string | null }[];
}

export type RunStatus = 'running' | 'waiting' | 'succeeded' | 'stopped' | 'failed' | 'cancelled';

export interface RunRow {
  id: string; workflowId: string; workflowName: string; version: number; mode: 'live' | 'test'; status: RunStatus; stepIndex: number; stepCount: number;
  outcome: string | null; error: string | null; createdAt: string; finishedAt: string | null; wakeAt: string | null; employeeName: string | null;
}

export interface RunDetail extends Omit<RunRow, 'stepCount' | 'employeeName'> {
  attempt: number; context: Record<string, unknown>; approvalRequestId: string | null; canRetry: boolean; canCancel: boolean;
  plan: { index: number; id: string; type: string; summary: string }[];
  steps: { index: number; stepId: string; type: string; attempt: number; status: string; detail: string; error: string | null; createdAt: string }[];
}

export interface WorkflowDraft { interactionId: string; definition: WorkflowDefinition | null; issues: { path: string; message: string }[] }
