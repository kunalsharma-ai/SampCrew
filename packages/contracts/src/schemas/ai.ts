import { z } from 'zod';

/** AI features a workspace can switch on separately. All start switched off. */
export const AI_FEATURES = ['assistant', 'helpdesk_draft', 'workflow_draft'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export const AI_FEATURE_LABEL: Record<AiFeature, string> = {
  assistant: 'HR assistant: answers employee questions from your published help articles',
  helpdesk_draft: 'Reply drafts: suggests replies to helpdesk cases for HR to check and send',
  workflow_draft: 'Workflow drafts: turns a plain-English description into a workflow to review and test',
};

export const aiSettingsInput = z.object({
  features: z.object({ assistant: z.boolean(), helpdesk_draft: z.boolean(), workflow_draft: z.boolean() }),
  /** Prompts and answers are kept this long for review, then removed; usage numbers are kept. */
  promptLogDays: z.number().int().min(7).max(730).default(90),
});
export type AiSettingsInput = z.infer<typeof aiSettingsInput>;

export const assistantAskInput = z.object({ question: z.string().trim().min(5, 'Ask a question of at least 5 characters').max(1000) });
export const aiFeedbackInput = z.object({ helpful: z.boolean(), comment: z.string().trim().max(500).default('') });
export type AiFeedbackInput = z.infer<typeof aiFeedbackInput>;

export const attritionReviewInput = z.object({
  outcome: z.enum(['action_planned', 'no_action', 'not_accurate']),
  note: z.string().trim().max(1000).default(''),
});
export type AttritionReviewInput = z.infer<typeof attritionReviewInput>;
