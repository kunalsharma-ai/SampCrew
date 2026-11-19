import type { Department } from '@/lib/types';

/** The department tree as a flat list of choices. */
export const flatDepartments = (list: Department[] | null): { id: string; name: string }[] =>
  (list ?? []).flatMap((d) => [{ id: d.id, name: d.name }, ...flatDepartments(d.children ?? [])]);
