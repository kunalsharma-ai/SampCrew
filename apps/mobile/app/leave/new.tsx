import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../src/lib/api';
import { randomId } from '../../src/lib/clock';
import { useSession } from '../../src/lib/session';
import type { Balance } from '../../src/lib/types';
import { Button, Card, Choice, Field, Notice, Screen, Text, useLoad } from '../../src/ui';

interface Preview { days: string; tracked: boolean; available: string | null; balanceAfter: string | null; holidaysInRange: string[]; warnings: string[] }

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function NewLeave() {
  const { api } = useSession();
  const router = useRouter();
  const { data: balances, error: loadError } = useLoad(() => api.get<{ balances: Balance[] }>('/leave/balances').then((b) => b.balances), [api]);
  const [typeId, setTypeId] = useState('');
  const [start, setStart] = useState(localToday());
  const [end, setEnd] = useState(localToday());
  const [half, setHalf] = useState<'full' | 'first_half' | 'second_half'>('full');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(randomId());

  const type = balances?.find((b) => b.leaveTypeId === typeId);
  useEffect(() => {
    if (!typeId && balances?.length) setTypeId(balances[0].leaveTypeId);
  }, [balances, typeId]);

  const body = useMemo(() => {
    const single = start === end;
    return {
      leaveTypeId: typeId,
      startDate: start,
      endDate: end,
      startHalf: single && half === 'second_half' ? 'second_half' : 'full',
      endHalf: single && half === 'first_half' ? 'first_half' : 'full',
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
  }, [typeId, start, end, half, reason]);

  const valid = typeId && isDate(start) && isDate(end) && end >= start;

  // Shows the working days and the balance after this request before it is sent (nothing is saved).
  useEffect(() => {
    setPreview(null);
    if (!valid) return;
    const t = setTimeout(() => {
      api.post<Preview>('/leave/requests/preview', body).then(setPreview, () => setPreview(null));
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
      await api.post('/leave/requests', body, key.current);
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send the request.');
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {loadError && <Notice tone="danger">{loadError}</Notice>}
      {error && <Notice tone="danger" testID="leave-error">{error}</Notice>}
      <Card>
        {balances && (
          <Choice
            label="Leave type"
            value={typeId}
            options={balances.map((b) => ({ value: b.leaveTypeId, label: b.tracked ? `${b.name} (${b.available})` : b.name }))}
            onChange={setTypeId}
          />
        )}
        <Field label="From (YYYY-MM-DD)" value={start} onChangeText={(v) => { setStart(v); if (end < v) setEnd(v); }} autoCapitalize="none" error={errors.startDate} />
        <Field label="To (YYYY-MM-DD)" value={end} onChangeText={setEnd} autoCapitalize="none" error={errors.endDate} />
        {start === end && type?.allowHalfDay && (
          <Choice
            label="Part of the day"
            value={half}
            options={[{ value: 'full', label: 'Full day' }, { value: 'first_half', label: 'First half' }, { value: 'second_half', label: 'Second half' }]}
            onChange={setHalf}
          />
        )}
        <Field label="Reason (optional)" value={reason} onChangeText={setReason} multiline maxLength={1000} error={errors.reason} />
        {preview && (
          <Notice tone={preview.warnings.length ? 'warn' : 'info'} testID="leave-preview">
            {`${preview.days} working day${preview.days === '1.00' ? '' : 's'}.${preview.balanceAfter !== null ? ` Balance after: ${preview.balanceAfter}.` : ''}${preview.holidaysInRange.length ? ` Holidays not counted: ${preview.holidaysInRange.join(', ')}.` : ''}${preview.warnings.length ? ` ${preview.warnings.join(' ')}` : ''}`}
          </Notice>
        )}
        <Text muted size={13}>Your approver is notified when you send this.</Text>
        <Button title="Send request" onPress={submit} busy={busy} disabled={!valid} testID="send-leave" />
      </Card>
    </Screen>
  );
}
