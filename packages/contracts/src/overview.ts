import { z } from 'zod';

/**
 * Module overviews: the KPI tiles and charts shown at the top of each module (Employees, Recruitment, Attendance,
 * Leave, Payroll, Performance, Learning, Analytics). Every number is computed from live records by the API and is
 * limited to what the member's roles let them see, using the same scope rules as the lists the tiles link to.
 */

export const OVERVIEW_MODULES = ['employees', 'recruitment', 'attendance', 'leave', 'payroll', 'performance', 'learning', 'analytics'] as const;
export type OverviewModule = (typeof OVERVIEW_MODULES)[number];
export const overviewModuleParam = z.enum(OVERVIEW_MODULES);

/** Tile colours of the neon design: each maps to a gradient that keeps white text at WCAG AA. */
export const TILE_TONES = ['violet', 'teal', 'orange', 'blue', 'pink', 'green'] as const;
export type TileTone = (typeof TILE_TONES)[number];

export interface OverviewTile {
  key: string;
  label: string;
  value: number | null;
  unit?: 'percent' | 'money' | 'days' | 'rating';
  currency?: string;
  /** Change against the comparison period, in the tile's own unit (or percentage points for percentages). */
  delta?: number | null;
  /** True when a rise is bad news (attrition, absences, overdue), so the delta is coloured accordingly. */
  invert?: boolean;
  hint?: string;
  tone: TileTone;
  icon: string;
  href?: string;
}

export interface SeriesPoint { label: string; value: number }
export interface Slice { label: string; value: number; color?: string; href?: string }
export interface ListItem { label: string; detail?: string | null; value?: string | null; href?: string | null; tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }

export type OverviewChart =
  | { kind: 'line'; key: string; title: string; points: SeriesPoint[]; unit?: 'percent' | 'money'; currency?: string; caption?: string }
  | { kind: 'bar'; key: string; title: string; points: SeriesPoint[]; unit?: 'percent' | 'money'; currency?: string; caption?: string }
  | { kind: 'donut'; key: string; title: string; slices: Slice[]; centerValue: string; centerLabel: string; unit?: 'money'; currency?: string }
  | { kind: 'ring'; key: string; title: string; value: number | null; label: string; caption?: string }
  | { kind: 'meter'; key: string; title: string; rows: { label: string; value: number; count: number }[]; caption?: string }
  | { kind: 'list'; key: string; title: string; items: ListItem[]; empty: string; href?: string };

export interface ModuleOverview {
  module: OverviewModule;
  generatedAt: string;
  /** The day the numbers are for, in the workspace's time zone. */
  today: string;
  tiles: OverviewTile[];
  charts: OverviewChart[];
}
