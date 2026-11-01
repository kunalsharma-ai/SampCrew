/**
 * Workforce Universe: rebuilds the organization on any date from employment records, and lists what changed
 * between two dates. Shared by the 3D map and its accessible 2D table, so both always show the same numbers.
 */

export interface UniversePerson {
  id: string; name: string; code: string; designation: string | null; joined: string; leftOn: string | null; status: string;
  departmentId: string | null; managerId: string | null; hasLogin: boolean;
}
export interface UniverseRecord {
  employeeId: string; from: string; to: string | null; departmentId: string | null; locationId: string | null; managerId: string | null;
  designation: string | null; reason: string;
}
export interface UniverseData {
  asOf: string;
  start: string;
  departments: { id: string; name: string; parentId: string | null; archived: boolean }[];
  locations: { id: string; name: string; city: string | null; countryCode: string | null; latitude: number | null; longitude: number | null }[];
  people: UniversePerson[];
  records: UniverseRecord[];
}

export interface PlacedPerson {
  id: string; name: string; code: string; designation: string | null; departmentId: string | null; managerId: string | null; locationId: string | null;
  joined: string; hasLogin: boolean;
}
export interface UniverseChange {
  kind: 'joined' | 'left' | 'moved' | 'promoted' | 'manager_changed';
  on: string; personId: string; name: string; fromDepartmentId?: string | null; toDepartmentId?: string | null; designation?: string | null;
}

/** True when someone is on the books on date d (joined on or before it and not yet past their last day). */
export const presentOn = (p: Pick<UniversePerson, 'joined' | 'leftOn'>, d: string) => p.joined <= d && (!p.leftOn || p.leftOn >= d);

function recordsByPerson(records: UniverseRecord[]) {
  const by = new Map<string, UniverseRecord[]>();
  for (const r of records) {
    const list = by.get(r.employeeId);
    if (list) list.push(r); else by.set(r.employeeId, [r]);
  }
  for (const list of by.values()) list.sort((a, b) => a.from.localeCompare(b.from));
  return by;
}

/** The record in effect on d: the latest one that started on or before d and has not ended. */
function recordOn(list: UniverseRecord[] | undefined, d: string): UniverseRecord | undefined {
  if (!list) return undefined;
  let hit: UniverseRecord | undefined;
  for (const r of list) if (r.from <= d && (!r.to || r.to >= d)) hit = r;
  return hit;
}

/** Everyone present on d, placed where their employment record put them that day. */
export function snapshot(u: Pick<UniverseData, 'people' | 'records'>, d: string): PlacedPerson[] {
  const by = recordsByPerson(u.records);
  const out: PlacedPerson[] = [];
  for (const p of u.people) {
    if (!presentOn(p, d)) continue;
    // Before their first record (a hire backdated after the fact) people sit where that first record puts them.
    const r = recordOn(by.get(p.id), d) ?? by.get(p.id)?.[0];
    out.push({
      id: p.id, name: p.name, code: p.code, joined: p.joined, hasLogin: p.hasLogin,
      designation: r ? r.designation : p.designation,
      departmentId: r ? r.departmentId : p.departmentId,
      managerId: r ? r.managerId : p.managerId,
      locationId: r ? r.locationId : null,
    });
  }
  return out;
}

/** Headcount per department on d. People with no department count under the key "none". */
export function headcount(people: PlacedPerson[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of people) m.set(p.departmentId ?? 'none', (m.get(p.departmentId ?? 'none') ?? 0) + 1);
  return m;
}

/** What changed after `from` up to and including `to`, oldest first. */
export function changes(u: Pick<UniverseData, 'people' | 'records'>, from: string, to: string): UniverseChange[] {
  const by = recordsByPerson(u.records);
  const name = new Map(u.people.map((p) => [p.id, p.name]));
  const out: UniverseChange[] = [];
  const inRange = (d: string | null) => !!d && d > from && d <= to;
  for (const p of u.people) {
    const list = by.get(p.id) ?? [];
    if (inRange(p.joined)) out.push({ kind: 'joined', on: p.joined, personId: p.id, name: p.name, toDepartmentId: (recordOn(list, p.joined) ?? list[0])?.departmentId ?? p.departmentId, designation: list[0]?.designation ?? p.designation });
    if (inRange(p.leftOn)) out.push({ kind: 'left', on: p.leftOn!, personId: p.id, name: p.name, fromDepartmentId: recordOn(list, p.leftOn!)?.departmentId ?? p.departmentId });
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const r = list[i]!;
      if (!inRange(r.from) || r.from === p.joined) continue;
      if (prev.departmentId !== r.departmentId) out.push({ kind: 'moved', on: r.from, personId: p.id, name: name.get(p.id) ?? '', fromDepartmentId: prev.departmentId, toDepartmentId: r.departmentId });
      else if (prev.designation !== r.designation || r.reason === 'promotion') out.push({ kind: 'promoted', on: r.from, personId: p.id, name: name.get(p.id) ?? '', designation: r.designation, toDepartmentId: r.departmentId });
      else if (prev.managerId !== r.managerId) out.push({ kind: 'manager_changed', on: r.from, personId: p.id, name: name.get(p.id) ?? '', toDepartmentId: r.departmentId });
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on) || a.name.localeCompare(b.name));
}

/** Slider stops: the last day of each month from the first joining date, ending on asOf. */
export function timeline(start: string, asOf: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (end >= asOf) break;
    out.push(end);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  out.push(asOf);
  return out;
}

/** Reporting lines that cross departments on d, counted per pair: how teams depend on each other. */
export function crossLinks(people: PlacedPerson[]): { a: string; b: string; count: number }[] {
  const dept = new Map(people.map((p) => [p.id, p.departmentId]));
  const pairs = new Map<string, number>();
  for (const p of people) {
    if (!p.managerId || !p.departmentId) continue;
    const md = dept.get(p.managerId);
    if (!md || md === p.departmentId) continue;
    const [a, b] = [p.departmentId, md].sort() as [string, string];
    pairs.set(`${a}|${b}`, (pairs.get(`${a}|${b}`) ?? 0) + 1);
  }
  return [...pairs].map(([k, count]) => { const [a, b] = k.split('|') as [string, string]; return { a, b, count }; });
}
