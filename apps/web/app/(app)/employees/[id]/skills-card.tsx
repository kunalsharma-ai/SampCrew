'use client';
import { type EmployeeSkill, SKILL_LEVEL_LABEL } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Input, Select } from '@crew/ui';
import { Pencil, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { saveSkillsAction } from '../../insights/universe/lens-actions';

type Row = { name: string; level: number };

/** The person's skills, which feed the skills network in the Workforce Universe. */
export function SkillsCard({ employeeId, initial, canEdit }: { employeeId: string; initial: EmployeeSkill[]; canEdit: boolean }) {
  const [skills, setSkills] = useState(initial);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const edit = () => { setRows(skills.length ? skills.map((s) => ({ name: s.name, level: s.level })) : [{ name: '', level: 2 }]); setError(null); setOpen(true); };
  const save = () => start(async () => {
    const body = { skills: rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), level: r.level })) };
    const r = await saveSkillsAction(employeeId, body);
    if (!r.ok) { setError([r.message, ...Object.values(r.fieldErrors ?? {})].filter(Boolean).join(' ')); return; }
    setSkills(r.data!.skills);
    setOpen(false);
  });
  return (
    <Card className="mt-4" aria-label="Skills">
      <CardHeader
        title="Skills"
        description={<>Shown in the <Link href="/insights/universe?lens=skills" className="text-accent hover:underline">skills network</Link>.</>}
        action={canEdit && <Button size="sm" variant="secondary" onClick={edit}><Pencil className="size-3.5" /> Edit skills</Button>}
      />
      <div className="flex flex-wrap gap-2 px-5 pb-5">
        {skills.length ? skills.map((s) => (
          <span key={s.skillId} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[0.8125rem]">
            {s.name} <Badge tone={s.level >= 3 ? 'success' : 'neutral'}>{SKILL_LEVEL_LABEL[s.level]}</Badge>
          </span>
        )) : <p className="text-[0.8125rem] text-fg-subtle">No skills recorded yet.</p>}
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Edit skills"
        description="Up to 30. Strong and Expert count as cover in the skills network."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} loading={pending}>Save skills</Button></>}
      >
        <div className="space-y-2">
          {error && <Alert tone="danger">{error}</Alert>}
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input aria-label={`Skill ${i + 1}`} value={r.name} maxLength={60} placeholder="e.g. Forklift" onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
              <Select aria-label={`Level of skill ${i + 1}`} className="!w-36" value={r.level} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, level: Number(e.target.value) } : x)))}>
                {[1, 2, 3, 4].map((l) => <option key={l} value={l}>{SKILL_LEVEL_LABEL[l]}</option>)}
              </Select>
              <Button size="sm" variant="ghost" aria-label={`Remove skill ${i + 1}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}><X className="size-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { name: '', level: 2 }])} disabled={rows.length >= 30}><Plus className="size-3.5" /> Add a skill</Button>
        </div>
      </Dialog>
    </Card>
  );
}
