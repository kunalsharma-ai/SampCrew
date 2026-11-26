'use client';
import { Alert, Button, Card, CardHeader, Checkbox, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveStatusRuleAction, type StatusRule } from '../actions';

/** Leave by employment status: none on probation where chosen, and the days credited when someone is confirmed. */
export function RulesPanel({ rules }: { rules: StatusRule[] }) {
  return (
    <Card data-testid="leave-status-rules">
      <CardHeader title="Leave rules by employment status" description="New joiners get no leave typed in at hire. For each type, choose whether people on probation may take it, and the days credited automatically on the day they are confirmed (made permanent)." />
      {rules.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">No leave types yet.</p> : (
        <Table aria-label="Leave rules by employment status">
          <THead><TR><TH>Leave type</TH><TH>On probation</TH><TH>Credited on confirmation</TH><TH>Rest of the year only</TH><TH /></TR></THead>
          <TBody>{rules.map((r) => <RuleRow key={r.leaveTypeId} r={r} />)}</TBody>
        </Table>
      )}
    </Card>
  );
}

function RuleRow({ r }: { r: StatusRule }) {
  const router = useRouter();
  const [probation, setProbation] = useState(r.probation);
  const [days, setDays] = useState(r.onConfirmationDays ?? '');
  const [prorate, setProrate] = useState(r.prorate);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const changed = probation !== r.probation || days !== (r.onConfirmationDays ?? '') || prorate !== r.prorate;
  return (
    <TR data-testid={`leave-rule-${r.code}`}>
      <TD><span className="font-medium">{r.name}</span> <span className="font-mono text-xs text-fg-subtle">{r.code}</span>{msg && <Alert tone={msg.ok ? 'success' : 'danger'} className="mt-2">{msg.text}</Alert>}</TD>
      <TD>
        <Select aria-label={`${r.name} on probation`} value={probation} onChange={(e) => setProbation(e.target.value as StatusRule['probation'])} className="w-44">
          <option value="no_leave">No leave on probation</option>
          <option value="allowed">Allowed on probation</option>
        </Select>
      </TD>
      <TD><Input aria-label={`${r.name} days on confirmation`} inputMode="decimal" placeholder="None" className="w-24" value={days} onChange={(e) => setDays(e.target.value)} /></TD>
      <TD><Checkbox label="Prorate" description="By the months left in the year" checked={prorate} onChange={(e) => setProrate(e.target.checked)} /></TD>
      <TD>
        <Button size="sm" disabled={!changed} loading={pending} onClick={() => start(async () => {
          const res = await saveStatusRuleAction(r.leaveTypeId, { probation, onConfirmationDays: days.trim() || null, prorate });
          setMsg({ ok: res.ok, text: res.ok ? res.message ?? 'Saved.' : res.message });
          if (res.ok) router.refresh();
        })}>Save</Button>
      </TD>
    </TR>
  );
}
