export type AiFeature = 'assistant' | 'helpdesk_draft' | 'workflow_draft';

export interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
  canUse: boolean;
  features: Record<AiFeature, { available: boolean; reason: string | null }>;
}

export interface AiSource { number: number; articleId: string; title: string; cited: boolean }
export interface AssistantAnswer { interactionId: string; answered: boolean; answer: string; sources: AiSource[]; model: string | null }
export interface ReplyDraft { interactionId: string; draft: string; sources: AiSource[]; model: string }

export interface AiSettings {
  configured: boolean;
  provider: string;
  model: string;
  features: Record<AiFeature, boolean>;
  promptLogDays: number;
  usage: { used: number; limit: number };
}

export interface AiUsage {
  used: number;
  limit: number;
  byFeature: { feature: AiFeature; calls: number; credits: number; inputTokens: number; outputTokens: number; avgLatencyMs: number; helpful: number; notHelpful: number }[];
  byStatus: { status: string; calls: number }[];
}

export interface AiInteractionRow {
  id: string; createdAt: string; feature: AiFeature; status: string; model: string; promptVersion: string; credits: number;
  inputTokens: number; outputTokens: number; latencyMs: number; helpful: boolean | null; subjectType: string | null; byName: string | null; purged: boolean; sourceCount: number;
}

export interface AiInteraction extends Omit<AiInteractionRow, 'purged' | 'sourceCount'> {
  provider: string;
  request: { system?: string; user?: string; maxTokens?: number } | null;
  response: string | null;
  evidence: { kind: string; id: string; title: string }[];
  redactions: Record<string, number>;
  error: string | null;
  feedback: string | null;
  purgedAt: string | null;
  subjectId: string | null;
}
