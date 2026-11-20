import { z } from 'zod';
import { CASE_PRIORITIES, CASE_STATUSES } from '../helpdesk-math';
import { isoDate } from './people';
import { audienceInput } from '../communication';

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
  /** Set when HR started from an AI draft; the person sending is still the author. */
  aiInteractionId: z.uuid().optional(),
});

export const caseStatusInput = z.object({
  status: z.enum(CASE_STATUSES),
  /** Shown to the person, for example the resolution. Required when resolving. */
  message: z.string().trim().max(5000).optional(),
});

/** The lead handler (assignee) and, optionally, other handlers who work the case with them. */
export const caseAssignInput = z.object({
  assigneeMembershipId: z.uuid().nullable(),
  collaboratorMembershipIds: z.array(z.uuid()).max(10, 'At most 10 people can share a case').optional(),
}).refine((v) => !v.collaboratorMembershipIds?.length || v.assigneeMembershipId, { message: 'Choose who leads the case first', path: ['assigneeMembershipId'] });
export const casePriorityInput = z.object({ priority: z.enum(CASE_PRIORITIES) });
export const caseCategoryInput = z.object({ categoryId: z.uuid() });

export const satisfactionInput = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).default(''),
});

// Announcements -----------------------------------------------------------------------------------------------


export const ANNOUNCEMENT_CATEGORIES = ['general', 'policy', 'event', 'holiday', 'celebration', 'safety', 'benefits', 'it', 'other'] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];
export const ANNOUNCEMENT_CATEGORY_LABELS: Record<AnnouncementCategory, string> = {
  general: 'General', policy: 'Policy', event: 'Event', holiday: 'Holiday', celebration: 'Celebration', safety: 'Safety', benefits: 'Benefits', it: 'IT and systems', other: 'Other',
};
export const ANNOUNCEMENT_PRIORITIES = ['normal', 'important', 'urgent'] as const;
export type AnnouncementPriority = (typeof ANNOUNCEMENT_PRIORITIES)[number];
export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const announcementInput = z
  .object({
    title: text(3, 200),
    /** Plain text. With `html`, it is worked out from the HTML on the server and this is ignored. */
    body: z.string().trim().max(10_000).default(''),
    /** Rich text (bold, lists, links ...), cleaned on the server. */
    html: z.string().max(100_000).nullable().default(null),
    /**
     * Who it is for: everyone, or any mix of departments, designations, groups and people. Null keeps the older
     * way of addressing (legal entity, department and location below, all empty for everyone).
     */
    audience: audienceInput.nullable().default(null),
    /** Narrows the audience to one legal entity or location (optional). */
    legalEntityId: z.uuid().nullable().default(null),
    departmentId: z.uuid().nullable().default(null),
    locationId: z.uuid().nullable().default(null),
    category: z.enum(ANNOUNCEMENT_CATEGORIES).default('general'),
    priority: z.enum(ANNOUNCEMENT_PRIORITIES).default('normal'),
    /** Files uploaded with POST /announcements/files. */
    fileIds: z.array(z.uuid()).max(10).default([]),
    requiresAck: z.boolean().default(false),
    pinned: z.boolean().default(false),
    expiresOn: isoDate.nullable().default(null),
    /** Publish later, at this time (with POST /announcements/:id/publish). */
    publishAt: z.iso.datetime({ offset: true }).nullable().default(null),
    /** On a published announcement whose wording changes: ask everyone to acknowledge the new version again. */
    askAgain: z.boolean().default(false),
  })
  .refine((a) => (a.html ? a.html.replace(/<[^>]+>/g, '').trim().length > 0 : a.body.length > 0), { message: 'Write the message', path: ['body'] });
export type AnnouncementInput = z.infer<typeof announcementInput>;
/** Publishing now, or at a later time. */
export const announcementPublishInput = z.object({ publishAt: z.iso.datetime({ offset: true }).nullable().default(null) });
export const announcementFeedQuery = z.object({
  category: z.enum(ANNOUNCEMENT_CATEGORIES).optional(),
  unread: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
});
