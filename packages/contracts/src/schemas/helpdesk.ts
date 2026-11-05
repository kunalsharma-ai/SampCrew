import { z } from 'zod';
import { CASE_PRIORITIES, CASE_STATUSES } from '../helpdesk-math';
import { isoDate } from './people';

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const hours = z.number().int().min(1).max(2160).nullable();

// Helpdesk ----------------------------------------------------------------------------------------------------

export const categoryInput = z
  .object({
    name: text(2, 80),
    description: z.string().trim().max(500).default(''),
    /** Confidential cases (for example a grievance) are seen only by the category's handlers. */
    confidential: z.boolean().default(false),
    firstResponseHours: hours.default(24),
    resolutionHours: hours.default(120),
    /** Handlers get new cases in this category; the first one is assigned automatically. */
    handlerMembershipIds: z.array(z.uuid()).max(20).default([]),
  })
  .refine((v) => !v.confidential || v.handlerMembershipIds.length > 0, { message: 'A confidential category needs at least one handler', path: ['handlerMembershipIds'] })
  .refine((v) => v.firstResponseHours === null || v.resolutionHours === null || v.resolutionHours >= v.firstResponseHours, { message: 'Resolution cannot be due before the first response', path: ['resolutionHours'] });
export type CategoryInput = z.infer<typeof categoryInput>;

export const articleInput = z.object({
  categoryId: z.uuid().nullable().default(null),
  title: text(3, 200),
  body: text(10, 20_000),
  published: z.boolean().default(true),
});
export type ArticleInput = z.infer<typeof articleInput>;

export const caseInput = z.object({
  categoryId: z.uuid(),
  subject: text(3, 200),
  description: text(10, 5000),
  priority: z.enum(CASE_PRIORITIES).default('normal'),
  /** Handlers can log a case for someone who called or walked in. */
  employeeId: z.uuid().optional(),
});
export type CaseInput = z.infer<typeof caseInput>;

export const caseMessageInput = z.object({
  body: text(1, 5000),
  /** Internal notes are visible to handlers only. */
  internal: z.boolean().default(false),
});

export const caseStatusInput = z.object({
  status: z.enum(CASE_STATUSES),
  /** Shown to the person, for example the resolution. Required when resolving. */
  message: z.string().trim().max(5000).optional(),
});

export const caseAssignInput = z.object({ assigneeMembershipId: z.uuid().nullable() });
export const casePriorityInput = z.object({ priority: z.enum(CASE_PRIORITIES) });
export const caseCategoryInput = z.object({ categoryId: z.uuid() });

export const satisfactionInput = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).default(''),
});

// Announcements -----------------------------------------------------------------------------------------------

export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const;

export const announcementInput = z.object({
  title: text(3, 200),
  body: text(1, 10_000),
  /** Leave all three empty to address everyone in the workspace. */
  legalEntityId: z.uuid().nullable().default(null),
  departmentId: z.uuid().nullable().default(null),
  locationId: z.uuid().nullable().default(null),
  requiresAck: z.boolean().default(false),
  pinned: z.boolean().default(false),
  expiresOn: isoDate.nullable().default(null),
});
export type AnnouncementInput = z.infer<typeof announcementInput>;
