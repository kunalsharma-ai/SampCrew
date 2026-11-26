import type { EmailTemplateKey } from '@crew/contracts';

export interface EmailTemplates {
  placeholders: readonly { key: string; description: string }[];
  defaultHtml: string;
  templates: { key: EmailTemplateKey; name: string; description: string; saved: boolean; active: boolean; subject: string | null; html: string | null; version: number; sourceFileName: string | null; updatedAt: string | null; updatedBy: string | null }[];
}
