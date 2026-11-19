import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ApiError } from '../../src/lib/api';
import { appraisalStage } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { AppraisalAnswers, AppraisalDetail } from '../../src/lib/types';
import { Badge, Button, Card, CardTitle, Choice, Field, fmt, Loading, Meter, Notice, Screen, Text, useLoad } from '../../src/ui';

/**
 * One appraisal. While the self-appraisal is open the employee scores each question and writes their answers, saves
 * a draft and submits; afterwards they see where it is and, once HR shares it, the result.
 */
export default function AppraisalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { data: a, error, reload } = useLoad(() => api.get<AppraisalDetail>(`/appraisals/${id}`), [api, id]);
  const [answers, setAnswers] = useState<AppraisalAnswers>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  useEffect(() => setAnswers(a?.answers.employee ?? {}), [a]);

  const editing = !!a && a.role === 'employee' && a.canEdit;
  const required = useMemo(() => (a ? a.definition.sections.filter((s) => s.kind === 'rated' || s.kind === 'self').flatMap((s) => s.questions.filter((q) => q.required)) : []), [a]);
  const left = required.filter((q) => (q.kind === 'score' ? answers[q.id]?.score == null : !answers[q.id]?.text?.trim())).length;

  if (!a) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Loading />}</Screen>;
  if (a.role !== 'employee') return <Screen><Notice tone="info">Manager and HR reviews are done in SampCrew on the web.</Notice></Screen>;
  const d = a.definition;
  const set = (qid: string, patch: AppraisalAnswers[string]) => setAnswers((x) => ({ ...x, [qid]: { ...x[qid], ...patch } }));
  const levelFor = (n: number) => d.scale.levels.find((l) => n >= l.from && n <= l.to)?.label;
  const save = async (submit: boolean) => {
    setBusy(submit ? 'submit' : 'save');
    setMsg(null);
    try {
      await api.put(`/appraisals/${a.id}/answers`, { answers });
      if (submit) await api.post(`/appraisals/${a.id}/submit`, {});
      setMsg({ tone: 'ok', text: submit ? 'Submitted. Your manager has been told.' : 'Draft saved.' });
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };
  const scores = Array.from({ length: d.scale.max - d.scale.min + 1 }, (_, i) => String(d.scale.min + i));

  return (
    <Screen onRefresh={reload}>
      <Stack.Screen options={{ title: a.cycle.name }} />
      {msg && <Notice tone={msg.tone} testID="appraisal-message">{msg.text}</Notice>}
      <Card testID="appraisal-header">
        <Text size={18} weight="700">{d.title}</Text>
        <Badge tone={a.stage === 'published' ? 'ok' : a.stage === 'self' ? 'warn' : 'info'}>{appraisalStage[a.stage] ?? a.stage}</Badge>
        <Text muted size={13}>{`${fmt.date(a.cycle.periodStart)} to ${fmt.date(a.cycle.periodEnd)}${a.cycle.selfDue && a.stage === 'self' ? ` · due ${fmt.date(a.cycle.selfDue)}` : ''}`}</Text>
        {a.employee.managerName ? <Text muted size={13}>{`Reviewer: ${a.employee.managerName}`}</Text> : null}
        {editing && d.intro ? <Text size={14}>{d.intro}</Text> : null}
      </Card>

      {a.stage === 'published' && a.result && (
        <Card testID="appraisal-result">
          <CardTitle help="appraisal.result">Your result</CardTitle>
          <Text size={28} weight="700">{a.result.finalPercent !== null ? `${a.result.finalPercent}%` : '—'}</Text>
          {a.result.band ? <Badge tone="ok">{a.result.band}</Badge> : null}
          {a.result.selfPercent !== null && <Meter label="Your self-score" value={a.result.selfPercent} max={100} caption={`${a.result.selfPercent}%`} />}
          {a.result.managerPercent !== null && <Meter label="Manager's score" value={a.result.managerPercent} max={100} caption={`${a.result.managerPercent}%`} />}
        </Card>
      )}
      {!editing && a.stage !== 'published' && <Notice tone="info">{a.stage === 'self' ? 'This appraisal is not open for you to edit.' : 'Your self-appraisal is submitted. You will see the result once HR shares it.'}</Notice>}

      {editing && (
        <Card>
          <CardTitle>Rating scale</CardTitle>
          {d.scale.levels.map((l) => <Text key={l.label} size={13}>{`${l.from === l.to ? l.from : `${l.from}–${l.to}`}: ${l.label}`}</Text>)}
        </Card>
      )}

      {d.sections.map((s) => {
        if (s.kind !== 'rated' && s.kind !== 'self' && !(a.stage === 'published' && Object.keys(a.answers[s.kind === 'manager' ? 'manager' : 'hr'] ?? {}).length)) return null;
        return (
          <Card key={s.id} testID={`section-${s.id}`}>
            <CardTitle>{s.title}</CardTitle>
            {s.description ? <Text muted size={13}>{s.description}</Text> : null}
            {s.questions.map((q) => {
              const mine = answers[q.id];
              if (s.kind === 'rated') {
                const final = a.result?.finals[q.id];
                return (
                  <View key={q.id} style={{ gap: 6 }}>
                    <Text size={14} weight="600">{`${q.text}${q.required && editing ? ' *' : ''}`}</Text>
                    {editing ? (
                      <>
                        <Choice value={mine?.score != null ? String(mine.score) : ''} onChange={(v) => set(q.id, { score: Number(v) })} options={scores.map((v) => ({ value: v, label: v }))} />
                        {mine?.score != null && <Text muted size={12}>{levelFor(mine.score) ?? ''}</Text>}
                        <Field label="Comment (optional)" value={mine?.comment ?? ''} onChangeText={(v) => set(q.id, { comment: v })} maxLength={4000} />
                      </>
                    ) : (
                      <Text muted size={13}>{`You: ${mine?.score ?? '—'}${a.stage === 'published' && final != null ? ` · Final: ${final}` : ''}`}</Text>
                    )}
                  </View>
                );
              }
              const source = s.kind === 'self' ? answers : (a.answers[s.kind === 'manager' ? 'manager' : 'hr'] ?? {});
              const own = s.kind === 'self';
              return editing && own ? (
                <Field key={q.id} label={`${q.text}${q.required ? ' *' : ''}`} value={mine?.text ?? ''} onChangeText={(v) => set(q.id, { text: v })} multiline maxLength={8000} />
              ) : (
                <View key={q.id} style={{ gap: 2 }}>
                  <Text size={14} weight="600">{q.text}</Text>
                  <Text muted size={13}>{source[q.id]?.text || '—'}</Text>
                </View>
              );
            })}
          </Card>
        );
      })}

      {editing && (
        <Card testID="appraisal-actions">
          {d.declaration ? <Text muted size={12}>{d.declaration}</Text> : null}
          <Text size={13}>{left ? `${left} required question${left === 1 ? '' : 's'} left.` : 'Every required question is answered.'}</Text>
          <Button kind="secondary" title="Save draft" busy={busy === 'save'} onPress={() => save(false)} testID="appraisal-save" />
          <Button title="Submit to my manager" disabled={left > 0} busy={busy === 'submit'} onPress={() => save(true)} testID="appraisal-submit" />
        </Card>
      )}
    </Screen>
  );
}
