import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { alpha } from '../lib/theme';
import { Row, Text, useTheme } from './index';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const monthOf = (date: string) => date.slice(0, 7);
export function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
export function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: isoDay(y, m, 1), to: isoDay(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate()) };
}
const monthTitle = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export interface DayMark { color: string; pending: boolean; label: string }

/**
 * A month grid (Monday first) drawn with plain views, so it behaves the same on phones and in the browser build.
 * Days can carry leave marks and holidays; weekly offs are greyed. `onSelect` makes days tappable.
 */
export function MonthCalendar({
  month, onMonthChange, marks, holidays, weeklyOffs = [], selected, min, onSelect, today, testID,
}: {
  month: string;
  onMonthChange: (m: string) => void;
  marks?: Map<string, DayMark[]>;
  holidays?: Map<string, { name: string; optional: boolean }>;
  weeklyOffs?: number[];
  selected?: { start: string; end: string };
  min?: string;
  onSelect?: (date: string) => void;
  today?: string;
  testID?: string;
}) {
  const t = useTheme();
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: last }, (_, i) => isoDay(y, m, i + 1))];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

  const nav = (by: number, label: string) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => onMonthChange(shiftMonth(month, by))} hitSlop={8} style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
      <Text size={18} weight="700" style={{ color: t.accent }}>{by < 0 ? '‹' : '›'}</Text>
    </Pressable>
  );

  return (
    <View testID={testID} style={{ gap: 6 }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        {nav(-1, 'Previous month')}
        <Text weight="700" testID={testID ? `${testID}-month` : undefined}>{monthTitle(month)}</Text>
        {nav(1, 'Next month')}
      </Row>
      <View style={{ flexDirection: 'row' }}>
        {WEEKDAYS.map((d, i) => (
          <View key={i} style={{ flex: 1, alignItems: 'center' }}><Text size={12} muted weight="600">{d}</Text></View>
        ))}
      </View>
      {weeks.map((week, wi) => (
        <View key={wi} style={{ flexDirection: 'row', gap: 2 }}>
          {week.map((date, di) => {
            if (!date) return <View key={di} style={{ flex: 1, minHeight: 44 }} />;
            const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
            const off = weeklyOffs.includes(dow);
            const hol = holidays?.get(date);
            const dayMarks = marks?.get(date) ?? [];
            const inSel = !!selected && date >= selected.start && date <= selected.end;
            const edge = !!selected && (date === selected.start || date === selected.end);
            const disabled = !onSelect || (!!min && date < min);
            // The spoken name starts with the day number the cell shows.
            const label = [new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }), off ? 'weekly off' : null, hol ? hol.name : null, ...dayMarks.map((x) => x.label), inSel ? 'selected' : null].filter(Boolean).join(', ');
            return (
              <Pressable
                key={date}
                testID={`day-${date}`}
                accessibilityRole={onSelect ? 'button' : undefined}
                accessibilityLabel={label}
                accessibilityState={{ disabled, selected: inSel }}
                disabled={disabled}
                onPress={() => onSelect?.(date)}
                style={{
                  flex: 1, minHeight: 44, borderRadius: 8, alignItems: 'center', paddingTop: 4, gap: 2,
                  backgroundColor: edge ? t.accent : inSel ? alpha(t.accent, 0.18) : off || (hol && !hol.optional) ? alpha(t.muted, 0.12) : 'transparent',
                  opacity: !!min && date < min ? 0.35 : 1,
                  borderWidth: date === today && !edge ? 1 : 0, borderColor: t.accent,
                }}
              >
                <Text size={14} weight={date === today || edge ? '700' : '400'} style={{ color: edge ? t.accentFg : off ? t.muted : t.fg }}>{String(Number(date.slice(8)))}</Text>
                {hol && <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.warn }} />}
                {dayMarks.slice(0, 2).map((x, i) => (
                  <View key={i} style={{ width: '80%', height: 4, borderRadius: 2, backgroundColor: x.pending ? 'transparent' : x.color, borderWidth: x.pending ? 1 : 0, borderColor: x.color, borderStyle: x.pending ? 'dashed' : 'solid' }} />
                ))}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** A date field that opens a month calendar to pick from, instead of typing YYYY-MM-DD. */
export function DateField({ label, value, onChange, min, error, testID }: { label: string; value: string; onChange: (d: string) => void; min?: string; error?: string; testID?: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(monthOf(value));
  const shown = new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return (
    <View style={{ gap: 4 }}>
      <Text size={13} weight="600">{label}</Text>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${shown}. ${open ? 'Close' : 'Open'} calendar`}
        onPress={() => { setMonth(monthOf(value)); setOpen((o) => !o); }}
        style={{ borderWidth: 1, borderColor: error ? t.danger : t.neon ? alpha(t.accent, 0.22) : t.border, borderRadius: t.neon ? 12 : 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: t.card, flexDirection: 'row', justifyContent: 'space-between' }}
      >
        <Text>{shown}</Text>
        <Text style={{ color: t.accent }}>{open ? '▲' : '📅'}</Text>
      </Pressable>
      {open && (
        <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, padding: 8, backgroundColor: t.card }}>
          <MonthCalendar month={month} onMonthChange={setMonth} selected={{ start: value, end: value }} min={min} onSelect={(d) => { onChange(d); setOpen(false); }} testID={testID ? `${testID}-calendar` : undefined} />
        </View>
      )}
      {error ? <Text size={13} style={{ color: t.danger }}>{error}</Text> : null}
    </View>
  );
}
