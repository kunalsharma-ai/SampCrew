import { z } from 'zod';

/**
 * Asset management: an inventory of company property (laptops, phones, SIM and ID cards ...), its assignment to
 * employees with their digital acknowledgement, returns, maintenance and write-offs, and reports.
 */

/** Categories every workspace starts with. HR can rename or archive them and add its own. */
export const DEFAULT_ASSET_CATEGORIES: readonly { code: string; name: string }[] = [
  { code: 'LAP', name: 'Laptops' },
  { code: 'DSK', name: 'Desktop computers' },
  { code: 'MON', name: 'Monitors' },
  { code: 'KBD', name: 'Keyboards' },
  { code: 'MOU', name: 'Mouse' },
  { code: 'CHG', name: 'Chargers and adapters' },
  { code: 'HPH', name: 'Headphones' },
  { code: 'MOB', name: 'Mobile phones' },
  { code: 'SIM', name: 'SIM cards' },
  { code: 'NTB', name: 'Notebooks and notepads' },
  { code: 'STN', name: 'Pens and stationery' },
  { code: 'ACC', name: 'Office accessories' },
  { code: 'IDC', name: 'ID cards' },
  { code: 'ACS', name: 'Access cards' },
  { code: 'OTH', name: 'Other company property' },
];

/** Where an asset is in its life. "Returned" is not a status: a returned asset is available again (or in repair). */
export const ASSET_STATUSES = ['available', 'assigned', 'under_maintenance', 'damaged', 'lost', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  available: 'Available', assigned: 'Assigned', under_maintenance: 'Under maintenance', damaged: 'Damaged', lost: 'Lost', retired: 'Retired',
};

export const ASSET_CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged'] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];
export const ASSET_CONDITION_LABEL: Record<AssetCondition, string> = { new: 'New', good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged' };

/**
 * The status changes HR can make by hand, from each status. Assigning and returning have their own actions;
 * lost and damaged (write-offs) need assets:approve.
 */
export const ASSET_MOVES: Record<AssetStatus, readonly AssetStatus[]> = {
  available: ['under_maintenance', 'damaged', 'lost', 'retired'],
  assigned: ['lost', 'damaged'],
  under_maintenance: ['available', 'damaged', 'retired'],
  damaged: ['under_maintenance', 'available', 'retired'],
  lost: ['available', 'retired'],
  retired: [],
};

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)');
const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use an amount such as 54999 or 54999.50');

export const assetCode = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/, 'Letters, numbers, dot, slash, dash and underscore');

export const assetCategoryInput = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, '2 to 8 letters or numbers, used to number assets (LAP-0001)'),
  description: optionalText(300),
}).strict();
export const assetCategoryUpdate = assetCategoryInput.partial().extend({ archived: z.boolean().optional() }).strict();

export const assetInput = z.object({
  name: z.string().trim().min(2).max(160),
  /** Left out: the next number in the category (LAP-0001, LAP-0002 ...). */
  assetCode: assetCode.optional().or(z.literal('').transform(() => undefined)),
  categoryId: z.uuid(),
  brand: optionalText(80),
  model: optionalText(120),
  serialNumber: optionalText(120),
  purchaseDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  purchasePrice: money.optional().or(z.literal('').transform(() => undefined)),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  vendor: optionalText(160),
  warrantyExpiry: isoDate.optional().or(z.literal('').transform(() => undefined)),
  condition: z.enum(ASSET_CONDITIONS).default('new'),
  location: optionalText(160),
  description: optionalText(2000),
  remarks: optionalText(2000),
}).strict().refine((v) => !v.purchaseDate || !v.warrantyExpiry || v.warrantyExpiry >= v.purchaseDate, { message: 'The warranty ends before the purchase date', path: ['warrantyExpiry'] });
export type AssetInput = z.infer<typeof assetInput>;

export const assetUpdate = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  assetCode: assetCode.optional(),
  categoryId: z.uuid().optional(),
  brand: nullableText(80),
  model: nullableText(120),
  serialNumber: nullableText(120),
  purchaseDate: isoDate.nullable().optional(),
  purchasePrice: money.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  vendor: nullableText(160),
  warrantyExpiry: isoDate.nullable().optional(),
  condition: z.enum(ASSET_CONDITIONS).optional(),
  location: nullableText(160),
  description: nullableText(2000),
  remarks: nullableText(2000),
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const assetAssignInput = z.object({
  employeeId: z.uuid(),
  assignedOn: isoDate,
  expectedReturnOn: isoDate.optional().or(z.literal('').transform(() => undefined)),
  condition: z.enum(ASSET_CONDITIONS),
  notes: optionalText(1000),
  /** Ask the employee to acknowledge it (default). Off only for records of assets handed over long ago. */
  requireAcknowledgement: z.boolean().default(true),
}).strict().refine((v) => !v.expectedReturnOn || v.expectedReturnOn >= v.assignedOn, { message: 'The return date is before the assignment date', path: ['expectedReturnOn'] });
export type AssetAssignInput = z.infer<typeof assetAssignInput>;

export const assetReturnInput = z.object({
  returnedOn: isoDate,
  condition: z.enum(ASSET_CONDITIONS),
  notes: optionalText(1000),
  /** Where the asset goes next. */
  nextStatus: z.enum(['available', 'under_maintenance', 'damaged']).default('available'),
}).strict();

export const assetStatusInput = z.object({
  status: z.enum(ASSET_STATUSES),
  note: z.string().trim().min(3, 'Say why, in a few words').max(1000),
  /** Maintenance: the repairer and the cost. */
  vendor: optionalText(160),
  cost: money.optional().or(z.literal('').transform(() => undefined)),
}).strict();

/** The employee's acceptance: they type their name and confirm they received the asset in the stated condition. */
export const assetAcknowledgeInput = z.object({
  fullName: z.string().trim().min(2).max(160),
  accept: z.literal(true, { error: 'Confirm that you received it' }),
  comment: optionalText(1000),
}).strict();

export const ASSET_REPORTS = ['employee', 'department', 'available', 'assigned', 'returned', 'damaged_lost', 'purchases', 'maintenance'] as const;
export type AssetReport = (typeof ASSET_REPORTS)[number];
export const ASSET_REPORT_LABEL: Record<AssetReport, string> = {
  employee: 'Employee-wise allocation',
  department: 'Department-wise allocation',
  available: 'Available inventory',
  assigned: 'Assigned inventory',
  returned: 'Returned assets',
  damaged_lost: 'Damaged or lost assets',
  purchases: 'Purchase history',
  maintenance: 'Maintenance history',
};

export const assetListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  categoryId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const assetReportQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryId: z.uuid().optional(),
});

/** The acceptance text the employee agrees to; its SHA-256 is kept with the acknowledgement as the digital record. */
export function acknowledgementText(a: { assetCode: string; name: string; serialNumber?: string | null; condition: string; assignedOn: string; employeeName: string }) {
  return `I, ${a.employeeName}, confirm that on ${a.assignedOn} I received ${a.name} (asset ${a.assetCode}${a.serialNumber ? `, serial ${a.serialNumber}` : ''}) in ${a.condition} condition. I will look after it, use it for work, and return it when asked or when I leave.`;
}

/** Next code in a category: the highest LAP-nnnn plus one, at least 4 digits. */
export function nextAssetCode(prefix: string, existing: string[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const max = existing.reduce((m, c) => {
    const n = re.exec(c)?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
