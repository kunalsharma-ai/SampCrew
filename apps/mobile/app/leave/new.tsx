import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../src/lib/api';
import { randomId } from '../../src/lib/clock';
import { useSession } from '../../src/lib/session';
import type { Balance } from '../../src/lib/types';
import { Button, Card, Choice, Field, Notice, Screen, Text, useLoad } from '../../src/ui';
import { DateField } from '../../src/ui/calendar';

type Route = 'hr' | 'super' | 'both';
interface Preview {
  days: string; tracked: boolean; available: string | null; balanceAfter: string | null; holidaysInRange: string[]; warnings: string[];
  routes?: { route: Route; label: string; reviewers: string[] }[]; employeeChooses?: boolean; route?: Route; reviewers?: string[];
  order?: 'simultaneous' | 'sequential'; managerFirst?: boolean;
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function NewLeave() {
  const { api } = useSession();
  const router = useRouter();
  // A day chosen on the leave calendar starts the request on that day.
  const params = useLocalSearchParams<{ date?: string }>();
  const startFrom = typeof params.date === 'string' && isDate(params.date) ? params.date : localToday();
  const [sent, setSent] = useState<string | null>(null);
  const { data: balances, error: loadError } = useLoad(() => api.get<{ balances: Balance[] }>('/leave/balances').then((b) => b.balances), [api]);
  const [typeId, setTypeId] = useState('');
  const [start, setStart] = useState(startFrom);
  const [end, setEnd] = useState(startFrom);
  const [half, setHalf] = useState<'full' | 'first_half' | 'second_half'>('full');
  const [reason, setReason] = useState('');
  // Where the application goes, when the leave type lets the employee choose (empty: the type's first route).
  const [route, setRoute] = useState<Route | ''>('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const type = balances?.find((b) => b.leaveTypeId === typeId);
  useEffect(() => {
    if (!typeId && balances?.length) setTypeId(balances[0].leaveTypeId);
  }, [balances, typeId]);
  useEffect(() => setRoute(''), [typeId]);

  const body = useMemo(() => {
    const single = start === end;
    return {
      leaveTypeId: typeId,
      startDate: start,
      endDate: end,
      startHalf: single && half === 'second_half' ? 'second_half' : 'full',
      endHalf: single && half === 'first_half' ? 'first_half' : 'full',
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(route ? { approvalRoute: route } : {}),
    };
  }, [typeId, start, end, half, reason, route]);

  const valid = typeId && isDate(start) && isDate(end) && end >= start;
  // One idempotency key per version of the request: a retry of the same request (say after a dropped connection)
  // is recorded once, while a changed request is a new one. A single key for the whole screen made the server
  // refuse a corrected request ("already used for a different request") after a first attempt timed out.
  const key = useMemo(() => randomId(), [body]);

  // Shows the working days and the balance after this request before it is sent (nothing is saved).
  useEffect(() => {
    setPreview(null);
    setRefusal(null);
    if (!valid) return;
    const t = setTimeout(() => {
      api.post<Preview>('/leave/requests/preview', body).then(setPreview, (e) => {
        setPreview(null);
        // The workspace's leave rules refuse these dates (notice period, balance, probation...): say why now,
        // next to the button, instead of only after sending.
        if (e instanceof ApiError && !e.offline && e.status >= 400 && e.status < 500) setRefusal(e.message);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [api, body, valid]);

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!isDate(start)) errs.startDate = 'Use the format YYYY-MM-DD';
    if (!isDate(end)) errs.endDate = 'Use the format YYYY-MM-DD';
    else if (end < start) errs.endDate = 'The end date is before the start date';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ waitingOn: string | null; status: string; approvalRouteLabel?: string; reference?: string }>('/leave/requests', body, key);
      // Say who it went to, so the request is not sent into silence.
      setSent(r.status === 'pending' ? `Sent${r.reference ? ` (${r.reference})` : ''} to ${r.approvalRouteLabel ?? 'approval'}. It is waiting${r.waitingOn ? ` for ${r.waitingOn}` : ''}. You will get a notification when it is decided.` : `Sent. Your request is ${r.status}.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send the request.');
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Screen>
        <Card>
          <Notice tone="ok" testID="leave-sent">{sent}</Notice>
          <Button title="Back to leave" onPress={() => router.back()} testID="leave-sent-done" />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      {loadError && <Notice tone="danger">{loadError}</Notice>}
      <Card>
        {balances && (
          <Choice
            label="Leave type"
            help="field.leaveType"
            value={typeId}
            options={balances.map((b) => ({ value: b.leaveTypeId, label: b.tracked ? `${b.name} (${b.available})` : b.name }))}
            onChange={setTypeId}
          />
        )}
        <DateField label="From" value={start} onChange={(v) => { setStart(v); if (end < v) setEnd(v); }} error={errors.startDate} testID="leave-start" />
        <DateField label="To" value={end} min={start} onChange={setEnd} error={errors.endDate} testID="leave-end" />
        {start === end && type?.allowHalfDay && (
          <Choice
            label="Part of the day"
            help="field.leaveDuration"
            value={half}
            options={[{ value: 'full', label: 'Full day' }, { value: 'first_half', label: 'First half' }, { value: 'second_half', label: 'Second half' }]}
            onChange={setHalf}
          />
        )}
        {preview?.employeeChooses && (preview.routes?.length ?? 0) > 1 && (
          <Choice
            label="Send it to"
            value={route || preview.route || preview.routes![0]!.route}
            options={preview.routes!.map((r) => ({ value: r.route, label: r.label }))}
            onChange={(v) => setRoute(v as Route)}
          />
        )}
        <Field label="Reason (optional)" value={reason} onChangeText={setReason} multiline maxLength={1000} error={errors.reason} />
        {preview && (
          <Notice tone={preview.warnings.length ? 'warn' : 'info'} testID="leave-preview">
            {`${preview.days} working day${preview.days === '1.00' ? '' : 's'}.${preview.balanceAfter !== null ? ` Balance after: ${preview.balanceAfter}.` : ''}${preview.holidaysInRange.length ? ` Holidays not counted: ${preview.holidaysInRange.join(', ')}.` : ''}${preview.warnings.length ? ` ${preview.warnings.join(' ')}` : ''}`}
          </Notice>
        )}
        {refusal && !error && <Notice tone="warn" testID="leave-refusal">{refusal}</Notice>}
        {/* Shown next to the button, where the person is looking (the top of the form can be scrolled away). */}
        {error && <Notice tone="danger" testID="leave-error">{error}</Notice>}
        {balances && balances.length === 0 && <Notice tone="warn">No leave types are allocated to you yet. Ask your HR Workspace to allocate them.</Notice>}
        <Text muted size={13} testID="leave-reviewers">{preview?.reviewers?.length ? `Goes to ${preview.reviewers.join(preview.order === 'sequential' ? ', then ' : ' and ')}${preview.managerFirst ? ', after your reporting manager' : ''}. They are notified when you send this.` : 'Your approver is notified when you send this.'}</Text>
        <Button title="Send request" onPress={submit} busy={busy} disabled={!valid} testID="send-leave" />
      </Card>
    </Screen>
  );
}
