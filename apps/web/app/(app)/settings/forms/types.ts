import type { CustomFieldDefinition } from '@crew/contracts';

export type FieldRow = CustomFieldDefinition & { valueCount?: number };
export interface FieldHistory { id: string; action: string; fieldId: string | null; by: string | null; at: string; changes: unknown }
