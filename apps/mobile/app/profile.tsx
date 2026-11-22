import { ACCOUNT_TYPES, MARITAL_STATUSES, PROFILE_SECTION_LABELS, type ProfileSection } from '@crew/contracts';
import { useState } from 'react';
import { View } from 'react-native';
import { ApiError } from '../src/lib/api';
import { profileUpdateStatus } from '../src/lib/labels';
import { useSession } from '../src/lib/session';
import type { MyProfile } from '../src/lib/types';
import { Badge, Button, Card, CardTitle, Choice, Empty, Field, fmt, Loading, Meter, Notice, Row, Screen, Text, useLoad, useReloadOnFocus } from '../src/ui';

const line = (label: string, value: string | null | undefined) => (
  <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
    <Text muted size={13}>{label}</Text>
    <Text size={13} style={{ flexShrink: 1, textAlign: 'right' }}>{value || '—'}</Text>
  </View>
);
const addr = (a: Record<string, string> | null | undefined) => (a ? [a.line1, a.line2, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ') : null);

type Editable = 'personal' | 'emergency' | 'address' | 'bank' | 'skills';
const ACCOUNT_LABEL: Record<string, string> = { savings: 'Savings', current: 'Current', salary: 'Salary', nre: 'NRE', nro: 'NRO', other: 'Other' };
const splitList = (v: string) => [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];

/**
 * My profile. Official details are read-only; personal details, emergency contacts, address, bank details and skills
 * are changed by sending an update that HR approves. Bank and identity numbers are shown masked, and a new bank
 * account is typed twice.
 */
export default function ProfileScreen() {
  const { api } = useSession();
  const { data: p, error, loading, reload } = useLoad(() => api.get<MyProfile>('/profile/me'), [api]);
  useReloadOnFocus(reload);
  const [editing, setEditing] = useState<Editable | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  if (!p) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Loading />}</Screen>;
  const s = p.sections;
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string) => (v: string) => setForm((x) => ({ ...x, [k]: v }));
  const open = (section: Editable) => {
    setMsg(null);
    const c = s.emergency?.contacts[0];
    const a = s.address?.current;
    const b = s.bank && !s.bank.hidden ? s.bank : null;
    setForm(
      section === 'personal' ? { preferredName: s.personal.preferredName ?? '', phone: s.personal.phone ?? '', personalEmail: s.personal.personalEmail ?? '', maritalStatus: s.personal.maritalStatus ?? '' }
      : section === 'emergency' ? { name: c?.name ?? '', relationship: c?.relationship ?? '', phone: c?.phone ?? '', email: c?.email ?? '' }
      : section === 'address' ? { line1: a?.line1 ?? '', line2: a?.line2 ?? '', city: a?.city ?? '', state: a?.state ?? '', postalCode: a?.postalCode ?? '', country: a?.country ?? '', same: s.address?.permanentSameAsCurrent === false ? 'no' : 'yes' }
      // The stored account number is masked, so a change always asks for the full number again.
      : section === 'bank' ? { accountHolderName: b?.accountHolderName ?? s.personal.firstName + (s.personal.lastName ? ` ${s.personal.lastName}` : ''), bankName: b?.bankName ?? '', accountNumber: '', accountNumber2: '', ifsc: b?.ifsc ?? '', branchName: b?.branchName ?? '', accountType: b?.accountType ?? 'savings' }
      : { skills: s.skills?.skills.join(', ') ?? '', languages: s.skills?.languages.join(', ') ?? '', certifications: s.skills?.certifications.join(', ') ?? '' },
    );
    setEditing(section);
  };
  const run = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
      setEditing(null);
      // Say it is done once the profile has reloaded, so the next change starts from fresh data.
      await reload();
      setMsg({ tone: 'ok', text: done });
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };
  const send = () => {
    const none = (v: string) => (v.trim() ? v.trim() : null);
    if (editing === 'bank' && f('accountNumber').replace(/\s/g, '') !== f('accountNumber2').replace(/\s/g, '')) {
      setMsg({ tone: 'danger', text: 'The two account numbers do not match. Type them again.' });
      return;
    }
    const current = { line1: f('line1').trim(), line2: f('line2').trim(), city: f('city').trim(), state: f('state').trim(), postalCode: f('postalCode').trim(), country: f('country').trim() };
    const data = editing === 'personal' ? { ...s.personal, preferredName: none(f('preferredName')), phone: none(f('phone')), personalEmail: none(f('personalEmail')), maritalStatus: none(f('maritalStatus')) }
      : editing === 'emergency' ? { contacts: [{ name: f('name').trim(), relationship: f('relationship').trim(), phone: f('phone').trim(), email: none(f('email')) }, ...(s.emergency?.contacts.slice(1) ?? [])] }
      : editing === 'address' ? { current, permanentSameAsCurrent: f('same') !== 'no', permanent: f('same') === 'no' ? (s.address?.permanent ?? null) : null }
      : editing === 'bank' ? { accountHolderName: f('accountHolderName').trim(), bankName: f('bankName').trim(), accountNumber: f('accountNumber').replace(/\s/g, ''), ifsc: f('ifsc').trim().toUpperCase(), branchName: none(f('branchName')), accountType: f('accountType') || 'savings' }
      : { skills: splitList(f('skills')), languages: splitList(f('languages')), certifications: splitList(f('certifications')) };
    return run('send', () => api.post(`/profile/${p.employee.id}/updates`, { section: editing, data }), 'Sent to HR. Your profile changes once HR approves it.');
  };
  const status = (section: ProfileSection) => {
    const u = p.updates[section];
    if (!u || !['pending', 'info_requested', 'rejected'].includes(u.status)) return null;
    const st = profileUpdateStatus[u.status]!;
    return (
      <View style={{ gap: 6 }}>
        <Row style={{ flexWrap: 'wrap' }}>
          <Badge tone={st.tone}>{st.label}</Badge>
          <Text muted size={12}>{`Sent ${fmt.date(u.createdAt)} · ${u.changes.length} change${u.changes.length === 1 ? '' : 's'}`}</Text>
        </Row>
        {u.remarks ? <Text size={13}>{`HR: ${u.remarks}`}</Text> : null}
        {u.status === 'pending' && <Button kind="secondary" title="Withdraw update" busy={busy === u.id} onPress={() => run(u.id, () => api.post(`/profile/updates/${u.id}/cancel`, {}), 'Update withdrawn.')} testID={`withdraw-${section}`} />}
      </View>
    );
  };
  const editable = (section: Editable) => p.can.submit && editing !== section && p.updates[section]?.status !== 'pending';

  return (
    <Screen onRefresh={reload} refreshing={loading}>
      {msg && !editing && <Notice tone={msg.tone} testID="profile-message">{msg.text}</Notice>}
      <Card testID="profile-header">
        <Text size={18} weight="700">{p.employee.name}</Text>
        <Text muted size={13}>{[p.employee.code, p.professional.designation, p.professional.department].filter(Boolean).join(' · ')}</Text>
        <Meter label="Profile complete" value={p.completeness} max={100} caption={`${p.completeness}%`} />
      </Card>

      <Card testID="profile-work">
        <CardTitle help="profile.work">Work details</CardTitle>
        {line('Manager', p.professional.manager)}
        {line('Location', p.professional.location?.name)}
        {line('Joined', fmt.date(p.professional.dateOfJoining))}
        {line('Work email', p.professional.workEmail)}
        {line('Shift', p.professional.shift ? `${p.professional.shift.name}, ${p.professional.shift.start} to ${p.professional.shift.end}` : null)}
        {line('Working days', p.professional.workingDays.map((d) => d.slice(0, 3)).join(', '))}
        <Text muted size={12}>Only HR changes these.</Text>
      </Card>

      <Card testID="profile-personal">
        <CardTitle help="profile.updates">{PROFILE_SECTION_LABELS.personal}</CardTitle>
        {status('personal')}
        {editing === 'personal' ? (
          <>
            <Field label="Preferred name" value={f('preferredName')} onChangeText={setF('preferredName')} maxLength={80} />
            <Field label="Mobile number" value={f('phone')} onChangeText={setF('phone')} keyboardType="phone-pad" maxLength={40} hint="With the country code, such as +91 98765 43210." />
            <Field label="Personal email" value={f('personalEmail')} onChangeText={setF('personalEmail')} keyboardType="email-address" autoCapitalize="none" maxLength={200} />
            <Choice label="Marital status" value={f('maritalStatus')} onChange={setF('maritalStatus')} options={MARITAL_STATUSES.map((m) => ({ value: m, label: m === 'undisclosed' ? 'Prefer not to say' : m[0]!.toUpperCase() + m.slice(1) }))} />
            {msg?.tone === 'danger' && <Notice tone="danger">{msg.text}</Notice>}
            <Button title="Send to HR" busy={busy === 'send'} onPress={send} testID="send-personal" />
            <Button kind="secondary" title="Cancel" onPress={() => setEditing(null)} />
          </>
        ) : (
          <>
            {line('Name', `${s.personal.firstName} ${s.personal.lastName}`.trim())}
            {line('Preferred name', s.personal.preferredName)}
            {line('Date of birth', s.personal.dateOfBirth ? fmt.date(s.personal.dateOfBirth) : null)}
            {line('Mobile', s.personal.phone)}
            {line('Personal email', s.personal.personalEmail)}
            {line('Marital status', s.personal.maritalStatus)}
            {line('Blood group', s.personal.bloodGroup)}
            {editable('personal') && <Button kind="secondary" title="Request a change" onPress={() => open('personal')} testID="edit-personal" />}
          </>
        )}
      </Card>

      <Card testID="profile-emergency">
        <CardTitle>{PROFILE_SECTION_LABELS.emergency}</CardTitle>
        {status('emergency')}
        {editing === 'emergency' ? (
          <>
            <Field label="Name" value={f('name')} onChangeText={setF('name')} maxLength={120} />
            <Field label="Relationship" value={f('relationship')} onChangeText={setF('relationship')} maxLength={60} />
            <Field label="Phone" value={f('phone')} onChangeText={setF('phone')} keyboardType="phone-pad" maxLength={40} />
            <Field label="Email (optional)" value={f('email')} onChangeText={setF('email')} keyboardType="email-address" autoCapitalize="none" maxLength={200} />
            {msg?.tone === 'danger' && <Notice tone="danger">{msg.text}</Notice>}
            <Button title="Send to HR" disabled={!f('name').trim() || !f('phone').trim()} busy={busy === 'send'} onPress={send} testID="send-emergency" />
            <Button kind="secondary" title="Cancel" onPress={() => setEditing(null)} />
          </>
        ) : (
          <>
            {!s.emergency?.contacts.length && <Empty>No emergency contact yet.</Empty>}
            {s.emergency?.contacts.map((c, i) => <View key={i}>{line(c.relationship, `${c.name}, ${c.phone}`)}</View>)}
            {editable('emergency') && <Button kind="secondary" title={s.emergency?.contacts.length ? 'Change main contact' : 'Add a contact'} onPress={() => open('emergency')} testID="edit-emergency" />}
          </>
        )}
      </Card>

      <Card testID="profile-address">
        <CardTitle>{PROFILE_SECTION_LABELS.address}</CardTitle>
        {status('address')}
        {editing === 'address' ? (
          <>
            <Field label="Address line 1" value={f('line1')} onChangeText={setF('line1')} maxLength={200} />
            <Field label="Address line 2 (optional)" value={f('line2')} onChangeText={setF('line2')} maxLength={200} />
            <Field label="City" value={f('city')} onChangeText={setF('city')} maxLength={80} />
            <Field label="State" value={f('state')} onChangeText={setF('state')} maxLength={80} />
            <Field label="Postal code" value={f('postalCode')} onChangeText={setF('postalCode')} maxLength={12} />
            <Field label="Country" value={f('country')} onChangeText={setF('country')} maxLength={60} />
            <Choice label="Permanent address" value={f('same')} onChange={setF('same')} options={[{ value: 'yes', label: 'Same as current' }, { value: 'no', label: 'Keep it as it is' }]} />
            {msg?.tone === 'danger' && <Notice tone="danger">{msg.text}</Notice>}
            <Button title="Send to HR" disabled={!f('line1').trim() || !f('city').trim()} busy={busy === 'send'} onPress={send} testID="send-address" />
            <Button kind="secondary" title="Cancel" onPress={() => setEditing(null)} />
          </>
        ) : (
          <>
            {line('Current', addr(s.address?.current))}
            {line('Permanent', s.address?.permanentSameAsCurrent ? 'Same as current' : addr(s.address?.permanent))}
            {editable('address') && <Button kind="secondary" title={s.address ? 'Request a change' : 'Add your address'} onPress={() => open('address')} testID="edit-address" />}
          </>
        )}
      </Card>

      <Card testID="profile-bank">
        <CardTitle help="profile.masked">Bank and identity</CardTitle>
        {status('bank')}
        {status('identity')}
        {editing === 'bank' ? (
          <>
            <Field label="Account holder name" value={f('accountHolderName')} onChangeText={setF('accountHolderName')} maxLength={120} />
            <Field label="Bank name" value={f('bankName')} onChangeText={setF('bankName')} maxLength={120} />
            <Field label="Account number" value={f('accountNumber')} onChangeText={setF('accountNumber')} keyboardType="number-pad" autoCapitalize="characters" maxLength={40} secureTextEntry hint="Type the full number. It is stored encrypted." />
            <Field label="Account number again" value={f('accountNumber2')} onChangeText={setF('accountNumber2')} keyboardType="number-pad" autoCapitalize="characters" maxLength={40} />
            <Field label="IFSC" value={f('ifsc')} onChangeText={setF('ifsc')} autoCapitalize="characters" maxLength={15} hint="Or the sort code or routing number outside India." />
            <Field label="Branch (optional)" value={f('branchName')} onChangeText={setF('branchName')} maxLength={120} />
            <Choice label="Account type" value={f('accountType')} onChange={setF('accountType')} options={ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_LABEL[t] ?? t }))} />
            {msg?.tone === 'danger' && <Notice tone="danger">{msg.text}</Notice>}
            <Button title="Send to HR" disabled={!f('accountNumber').trim() || !f('bankName').trim() || !f('ifsc').trim()} busy={busy === 'send'} onPress={send} testID="send-bank" />
            <Button kind="secondary" title="Cancel" onPress={() => setEditing(null)} />
          </>
        ) : s.bank?.hidden || s.identity?.hidden ? <Text muted size={13}>Hidden.</Text> : (
          <>
            {line('Bank', s.bank?.bankName)}
            {line('Account', s.bank?.accountNumber)}
            {line('IFSC', s.bank?.ifsc)}
            {line('PAN', s.identity?.pan)}
            {line('Aadhaar', s.identity?.aadhaar)}
            {editable('bank') && <Button kind="secondary" title={s.bank?.accountNumber ? 'Change bank account' : 'Add bank account'} onPress={() => open('bank')} testID="edit-bank" />}
          </>
        )}
        <Text muted size={12}>Numbers are stored encrypted and show only the last 4 characters.</Text>
      </Card>

      <Card testID="profile-skills">
        <CardTitle>{PROFILE_SECTION_LABELS.skills}</CardTitle>
        {status('skills')}
        {editing === 'skills' ? (
          <>
            <Field label="Skills" value={f('skills')} onChangeText={setF('skills')} multiline maxLength={2000} hint="Separate them with commas." />
            <Field label="Languages" value={f('languages')} onChangeText={setF('languages')} maxLength={600} hint="Separate them with commas." />
            <Field label="Certifications" value={f('certifications')} onChangeText={setF('certifications')} multiline maxLength={2000} hint="Separate them with commas." />
            {msg?.tone === 'danger' && <Notice tone="danger">{msg.text}</Notice>}
            <Button title="Send to HR" busy={busy === 'send'} onPress={send} testID="send-skills" />
            <Button kind="secondary" title="Cancel" onPress={() => setEditing(null)} />
          </>
        ) : (
          <>
            {line('Skills', s.skills?.skills.join(', ') || null)}
            {line('Languages', s.skills?.languages.join(', ') || null)}
            {line('Certifications', s.skills?.certifications.join(', ') || null)}
            {editable('skills') && <Button kind="secondary" title="Request a change" onPress={() => open('skills')} testID="edit-skills" />}
          </>
        )}
      </Card>

      <Card>
        <CardTitle>More on the web</CardTitle>
        <Text muted size={13}>Education, previous jobs and identity numbers need their documents, so they are changed in SampCrew on the web under My profile.</Text>
        {(['education', 'employment'] as const).map((k) => line(PROFILE_SECTION_LABELS[k], `${(k === 'education' ? s.education?.records.length : s.employment?.records.length) ?? 0} added`))}
      </Card>
    </Screen>
  );
}
