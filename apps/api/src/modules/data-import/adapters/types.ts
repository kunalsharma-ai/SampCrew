import type { ImportField, ImportIssue, ImportOptions, ImportType, MasterList } from '@crew/contracts';
import type { TenantTx } from '../../../platform/database/mongo.service';
import type { ListEntry } from '../../master-data/master-data.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

/** One row of the file as its mapped fields: field key > the cell's text (trimmed). */
export interface MappedRow {
  row: number;
  values: Record<string, string>;
  /** The column each field came from, as named in the file (for messages and the error report). */
  columns: Record<string, string>;
}

/** What a check found: problems, an existing record it matches, and what the write needs. */
export interface Checked {
  issues: ImportIssue[];
  label: string | null;
  match: { recordId: string; label: string; by: string } | null;
  /** The match is on a field that must be unique: "create a new record anyway" is refused. */
  uniqueMatch: boolean;
  /** Rows of the same file this one needs first (a manager, a parent department). */
  after: number[];
  /** What the write uses (already checked). */
  data: Doc;
}

/** Values a row needs added to a master data list before it is written. */
export interface ListNeed { list: MasterList; label: string }

/** Everything an adapter may look at, read once per validation or run and kept up to date as rows are written. */
export interface Lookups {
  /** Per list: the entries, including values added during this run. */
  lists: Map<MasterList, ListEntry[]>;
  /** Lists the person may add to (masterdata:manage, departments org:manage) and the import's option allows it. */
  mayAdd: Set<MasterList>;
  [key: string]: unknown;
}

/** Index of the file itself: which rows hold a value (normalised), for duplicates within the file and links to other rows. */
export type FileIndex = Map<string, Map<string, number[]>>;

export interface WriteResult { id: string; label: string; action: 'imported' | 'updated' }

export interface Writer {
  tx: TenantTx;
  /** Adds the values the row needs to their lists (inside the row's transaction) and returns their ids. */
  ensureValues: (tx: TenantTx, needs: ListNeed[]) => Promise<Map<string, ListEntry>>;
  /** Saves the row's custom field values on the record (inside the record's transaction). */
  saveCustom: (tx: TenantTx, recordId: string, creating: boolean) => Promise<void>;
  jobId: string;
}

export interface ImportAdapter<L extends Lookups = Lookups> {
  type: ImportType;
  /** Fields of this type (custom fields are added by the service). */
  fields: (options: ImportOptions) => ImportField[];
  /** Reads the reference data the checks need, once. */
  load: (tx: TenantTx, options: ImportOptions, base: Lookups) => Promise<L>;
  /** Index keys of the file this type uses ("employeeCode", "email"...). */
  indexFields: string[];
  /** Checks one row against the lookups (no database access) and says what will happen. */
  check: (r: MappedRow, lk: L, file: FileIndex, options: ImportOptions) => Checked;
  /**
   * Writes one checked row: a new record, or an update of the matched one. The record and its custom fields are
   * saved together; a problem throws and nothing of the row is kept. `created` maps rows of this file to the records
   * they made, for links between rows.
   */
  write: (c: Checked, r: MappedRow, action: 'create' | 'update', lk: L, w: Omit<Writer, 'tx'>, created: Map<number, string>) => Promise<WriteResult>;
  /** Where an imported record opens in SampCrew. */
  href: (id: string) => string | null;
}

// Shared helpers ------------------------------------------------------------------------------------------------------

export const lc = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
export const phoneKey = (v: unknown) => digits(v).slice(-10);

/** A problem with a field of the row, with the column as the file names it. */
export function issue(r: MappedRow, field: string, level: 'error' | 'warning', message: string, suggestion?: string): ImportIssue {
  return { field, column: r.columns[field] ?? null, level, message, ...(suggestion ? { suggestion } : {}) };
}

/** Other rows of the file with the same value in a field. */
export function sameInFile(file: FileIndex, field: string, key: string, row: number): number[] {
  if (!key) return [];
  return (file.get(field)?.get(key) ?? []).filter((n) => n !== row);
}

/** First and last name from the row: the two columns, or a full name split at the last space. */
export function nameParts(v: Record<string, string>): { first: string; last: string } {
  if (v.firstName || v.lastName) return { first: v.firstName ?? '', last: v.lastName ?? '' };
  const full = (v.fullName ?? '').replace(/\s+/g, ' ').trim();
  if (!full) return { first: '', last: '' };
  const at = full.lastIndexOf(' ');
  return at < 0 ? { first: full, last: '' } : { first: full.slice(0, at), last: full.slice(at + 1) };
}
