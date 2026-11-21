import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ApiError } from '../../src/lib/api';
import { appraisalStage, reviewStage } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { AppraisalAnswers, AppraisalDetail, AppraisalSectionDef } from '../../src/lib/types';
import { Badge, Button, Card, CardTitle, Choice, Field, fmt, Loading, Meter, Notice, Screen, Text, useLoad } from '../../src/ui';
import { ModuleGate } from '../../src/ui/kit';

type Role = AppraisalDetail['role'];
const WHO: Record<Role, string> = { employee: 'You', manager: 'Manager', hr: 'HR' };
const SUBMIT: Record<Role, { title: string; done: string }> = {
  employee: { title: 'Submit to my manager', done: 'Submitted. Your manager has been told.' },
  manager: { title: 'Submit evaluation', done: 'Evaluation submitted. HR has been told.' },
  hr: { title: 'Finalise appraisal', done: 'Finalised. Share the result when you are ready.' },
};

/** Which part of a section the viewer writes in: a score, an HR comment on a score, or a written answer. */
function writes(s: AppraisalSectionDef, role: Role, hrScores: boolean): 'score' | 'comment' | 'text' | null {
  if (s.kind === 'rated') return role !== 'hr' || hrScores ? 'score' : 'comment';
  return s.kind === (role === 'employee' ? 'self' : role) ? 'text' : null;
}
const shown = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

/**
 * One appraisal, for whoever opens it. The employee writes the self-appraisal; their manager scores each question
 * against the employee's own scores and writes the manager section; HR reviews both, can set a final score per
 * question or an approved percentage (with a reason), finalises and shares the result. Each part saves as a draft
 * and locks on submit.
 */
function AppraisalScreenBody() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { data: a, error, reload } = useLoad(() => api.get<AppraisalDetail>(`/appraisals/${id}`), [api, id]);
  const [answers, setAnswers] = useState<AppraisalAnswers>({});
  const [finals, setFinals] = useState<Record<string, number | null>>({});
  const [finalPercent, setFinalPercent] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (!a) return;
    setAnswers(a.answers[a.role] ?? {});
    setFinals(a.answers.finalScores ?? {});
    setFinalPercent(a.finalPercentOverride == null ? '' : String(a.finalPercentOverride));
    setReason(a.overrideReason ?? '');
  }, [a]);

  const role: Role = a?.role ?? 'employee';
  const editing = !!a && a.canEdit;
  const hrScores = !!a?.definition.scoring?.hrScores;
  const missing = useMemo(() => {
    if (!a || !editing) return 0;
    let n = 0;
    for (const s of a.definition.sections) {
      const w = writes(s, role, hrScores);
      for (const q of s.questions) {
        if (!q.required) continue;
        if (w === 'score' && answers[q.id]?.score == null) n++;
        if (w === 'text' && !answers[q.id]?.text?.trim()) n++;
      }
    }
    return n;
  }, [a, answers, editing, role, hrScores]);

  if (!a) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Loading />}</Screen>;
  const d = a.definition;
  const isHr = role === 'hr';
  const set = (qid: string, patch: AppraisalAnswers[string]) => setAnswers((x) => ({ ...x, [qid]: { ...x[qid], ...patch } }));
  const levelFor = (n: number) => d.scale.levels.find((l) => n >= l.from && n <= l.to)?.label;
  const body = () => {
    const b: Record<string, unknown> = { answers };
    if (isHr) {
      b.finalScores = finals;
      b.finalPercent = finalPercent.trim() === '' ? null : Number(finalPercent);
      b.overrideReason = reason.trim() || null;
    }
    return b;
  };
  const run = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
      // Reload first: the answers on screen are replaced by the saved ones, so nothing typed after the message is lost.
      await reload();
      setMsg({ tone: 'ok', text: done });
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };
  const save = (submit: boolean) => {
    if (isHr && finalPercent.trim() && !reason.trim()) {
      setMsg({ tone: 'danger', text: 'Say why the approved percentage differs from the calculated one.' });
      return;
    }
    return run(submit ? 'submit' : 'save', async () => {
      await api.put(`/appraisals/${a.id}/answers`, body());
      if (submit) await api.post(`/appraisals/${a.id}/submit`, {});
    }, submit ? SUBMIT[role].done : 'Draft saved.');
  };
  const scores = Array.from({ length: d.scale.max - d.scale.min + 1 }, (_, i) => String(d.scale.min + i));
  const others = (qid: string) => {
    const parts: string[] = [];
    if (role !== 'employee') parts.push(`Employee: ${shown(a.answers.employee?.[qid]?.score)}`);
    if (isHr) parts.push(`Manager: ${shown(a.answers.manager?.[qid]?.score)}`);
    if (!editing && role !== 'hr') parts.push(`${WHO[role]}: ${shown(answers[qid]?.score)}`);
    const final = a.result?.finals[qid];
    if ((a.stage === 'published' || isHr) && final != null) parts.push(`Final: ${final}`);
    return parts.join(' · ');
  };
  const stageText = role === 'employee' ? (appraisalStage[a.stage] ?? a.stage) : (reviewStage[a.stage] ?? a.stage);

  return (
    <Screen onRefresh={reload}>
      <Stack.Screen options={{ title: role === 'employee' ? a.cycle.name : a.employee.name }} />
      {msg && <Notice tone={msg.tone} testID="appraisal-message">{msg.text}</Notice>}
      <Card testID="appraisal-header">
        <Text size={18} weight="700">{role === 'employee' ? d.title : a.employee.name}</Text>
        <Badge tone={a.stage === 'published' ? 'ok' : a.stage === role || (role === 'employee' && a.stage === 'self') ? 'warn' : 'info'}>{stageText}</Badge>
        {role !== 'employee' && <Text muted size={13}>{[a.employee.designation, a.employee.department, a.cycle.name].filter(Boolean).join(' · ')}</Text>}
        <Text muted size={13}>{`${fmt.date(a.cycle.periodStart)} to ${fmt.date(a.cycle.periodEnd)}${a.cycle.selfDue && a.stage === 'self' ? ` · self-appraisal due ${fmt.date(a.cycle.selfDue)}` : ''}`}</Text>
        {role === 'employee' && a.employee.managerName ? <Text muted size={13}>{`Reviewer: ${a.employee.managerName}`}</Text> : null}
        {editing && role === 'employee' && d.intro ? <Text size={14}>{d.intro}</Text> : null}
      </Card>

      {(a.stage === 'published' || role !== 'employee') && a.result && (
        <Card testID="appraisal-result">
          <CardTitle help="appraisal.result">{role === 'employee' ? 'Your result' : 'Result so far'}</CardTitle>
          <Text size={28} weight="700" testID="appraisal-final">{a.result.finalPercent !== null ? `${a.result.finalPercent}%` : '—'}</Text>
          {a.result.band ? <Badge tone="ok">{a.result.band}</Badge> : null}
          {a.result.selfPercent !== null && <Meter label={role === 'employee' ? 'Your self-score' : 'Self-score'} value={a.result.selfPercent} max={100} caption={`${a.result.selfPercent}%`} />}
          {a.result.managerPercent !== null && <Meter label="Manager's score" value={a.result.managerPercent} max={100} caption={`${a.result.managerPercent}%`} />}
          {isHr && a.result.calculatedPercent != null && <Text muted size={13}>{`Calculated: ${a.result.calculatedPercent}%`}</Text>}
          {a.overrideReason && a.stage !== 'hr' ? <Text muted size={12}>{`Changed by HR: ${a.overrideReason}`}</Text> : null}
        </Card>
      )}
      {!editing && a.stage !== 'published' && (
        <Notice tone="info">
          {role === 'employee'
            ? a.stage === 'self' ? 'This appraisal is not open for you to edit.' : 'Your self-appraisal is submitted. You will see the result once HR shares it.'
            : role === 'manager'
              ? a.stage === 'self' ? 'You can evaluate once the employee submits their self-appraisal.' : 'Your evaluation is submitted. HR reviews it next.'
              : a.stage === 'finalized' ? 'Finalised. Share the result with the employee when you are ready.' : 'HR reviews this once the manager submits.'}
        </Notice>
      )}

      {editing && (
        <Card>
          <CardTitle>Rating scale</CardTitle>
          {d.scale.levels.map((l) => <Text key={l.label} size={13}>{`${l.from === l.to ? l.from : `${l.from}–${l.to}`}: ${l.label}`}</Text>)}
        </Card>
      )}

      {d.sections.map((s) => {
        const w = editing ? writes(s, role, hrScores) : null;
        if (s.kind === 'rated') {
          return (
            <Card key={s.id} testID={`section-${s.id}`}>
              <CardTitle>{s.title}</CardTitle>
              {s.description ? <Text muted size={13}>{s.description}</Text> : null}
              {s.questions.map((q) => {
                const mine = answers[q.id];
                const line = others(q.id);
                const employeeComment = role === 'manager' ? a.answers.employee?.[q.id]?.comment : isHr ? a.answers.manager?.[q.id]?.comment : null;
                return (
                  <View key={q.id} style={{ gap: 6 }} testID={`question-${q.id}`}>
                    <Text size={14} weight="600">{`${q.text}${q.required && w === 'score' ? ' *' : ''}`}</Text>
                    {line ? <Text muted size={13}>{line}</Text> : null}
                    {employeeComment ? <Text muted size={12}>{`${role === 'manager' ? 'Employee' : 'Manager'} comment: ${employeeComment}`}</Text> : null}
                    {w === 'score' && (
                      <>
                        <Choice label={role === 'employee' ? undefined : `${WHO[role]} score`} value={mine?.score != null ? String(mine.score) : ''} onChange={(v) => set(q.id, { score: Number(v) })} options={scores.map((v) => ({ value: v, label: v }))} />
                        {mine?.score != null && <Text muted size={12}>{levelFor(mine.score) ?? ''}</Text>}
                        <Field label="Comment (optional)" value={mine?.comment ?? ''} onChangeText={(v) => set(q.id, { comment: v })} maxLength={4000} />
                      </>
                    )}
                    {w === 'comment' && <Field label="HR comment (optional)" value={mine?.comment ?? ''} onChangeText={(v) => set(q.id, { comment: v })} maxLength={4000} />}
                    {isHr && editing && (
                      <Choice
                        label="Final score"
                        value={finals[q.id] == null ? '' : String(finals[q.id])}
                        onChange={(v) => setFinals((x) => ({ ...x, [q.id]: v === '' ? null : Number(v) }))}
                        options={[{ value: '', label: 'Calculated' }, ...scores.map((v) => ({ value: v, label: v }))]}
                      />
                    )}
                  </View>
                );
              })}
            </Card>
          );
        }
        // Written sections: the employee's, the manager's and HR's.
        const owner: Role = s.kind === 'self' ? 'employee' : s.kind === 'manager' ? 'manager' : 'hr';
        const own = owner === role;
        const source = own ? answers : (a.answers[owner] ?? {});
        if (!own && !Object.keys(source).length) return null;
        return (
          <Card key={s.id} testID={`section-${s.id}`}>
            <CardTitle>{s.title}</CardTitle>
            {s.description ? <Text muted size={13}>{s.description}</Text> : <Text muted size={12}>{`Written by: ${owner === 'employee' ? 'Employee' : WHO[owner]}`}</Text>}
            {s.questions.map((q) => (w === 'text' ? (
              <Field key={q.id} label={`${q.text}${q.required ? ' *' : ''}`} value={answers[q.id]?.text ?? ''} onChangeText={(v) => set(q.id, { text: v })} multiline maxLength={8000} />
            ) : (
              <View key={q.id} style={{ gap: 2 }}>
                <Text size={14} weight="600">{q.text}</Text>
                <Text muted size={13}>{source[q.id]?.text || '—'}</Text>
              </View>
            )))}
          </Card>
        );
      })}

      {isHr && editing && (
        <Card testID="appraisal-final-percent">
          <CardTitle>Final percentage</CardTitle>
          <Text muted size={13}>{`Calculated: ${a.result?.calculatedPercent ?? '—'}%. Leave the box empty to use it, or record a different approved percentage with a reason.`}</Text>
          <Field label="Approved %" value={finalPercent} onChangeText={setFinalPercent} keyboardType="decimal-pad" maxLength={5} />
          <Field label="Reason for the change" value={reason} onChangeText={setReason} multiline maxLength={1000} />
        </Card>
      )}

      {editing && (
        <Card testID="appraisal-actions">
          {role === 'employee' && d.declaration ? <Text muted size={12}>{d.declaration}</Text> : null}
          <Text size={13}>{missing ? `${missing} required question${missing === 1 ? '' : 's'} left.` : 'Every required question is answered.'}</Text>
          <Text muted size={12}>{`Your ${role === 'employee' ? 'self-appraisal' : role === 'manager' ? 'evaluation' : 'review'} locks once you submit. Only HR can reopen it.`}</Text>
          <Button kind="secondary" title="Save draft" busy={busy === 'save'} onPress={() => save(false)} testID="appraisal-save" />
          <Button title={SUBMIT[role].title} disabled={missing > 0} busy={busy === 'submit'} onPress={() => save(true)} testID="appraisal-submit" />
        </Card>
      )}
      {isHr && a.stage === 'finalized' && (
        <Card testID="appraisal-publish">
          <Text size={13}>{`${a.employee.name} will see the manager's scores, the final ${a.result?.finalPercent ?? '—'}% and the category "${a.result?.band ?? '—'}", and is notified.`}</Text>
          <Button title="Share result with employee" busy={busy === 'publish'} onPress={() => run('publish', () => api.post(`/appraisals/${a.id}/publish`, {}), 'Result shared. The employee has been told.')} testID="appraisal-share" />
        </Card>
      )}
    </Screen>
  );
}

export default function AppraisalScreen() {
  return (
    <ModuleGate module="appraisal">
      <AppraisalScreenBody />
    </ModuleGate>
  );
}
