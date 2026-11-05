import type { RiskFactor } from '@crew/contracts';

export type Band = 'low' | 'medium' | 'high';
export type ReviewOutcome = 'action_planned' | 'no_action' | 'not_accurate';

export interface AttritionList {
  rulesVersion: string;
  rules: Record<string, number>;
  computedOn: string | null;
  people: { employeeId: string; name: string; department: string | null; score: number; band: Band; factors: RiskFactor[]; computedOn: string; reviewOutcome: ReviewOutcome | null; reviewedAt: string | null }[];
}

export interface AttritionPerson {
  employeeId: string;
  name: string;
  history: { id: string; computedOn: string; score: number; band: Band; factors: RiskFactor[]; inputs: Record<string, number | null>; rulesVersion: string }[];
  reviews: { id: string; outcome: ReviewOutcome; note: string; createdAt: string; score: number; scoreOn: string; byName: string }[];
}

export interface PayrollChecks {
  runId: string;
  thresholdPct: number;
  checked: number;
  flagged: number;
  people: { itemId: string; employeeId: string; name: string; months: number; anomalies: { code: string; severity: 'info' | 'warning' | 'danger'; message: string }[] }[];
}
