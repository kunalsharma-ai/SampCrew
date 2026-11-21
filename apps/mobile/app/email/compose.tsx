import { htmlToText } from '@crew/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSession } from '../../src/lib/session';
import type { Person } from '../../src/lib/types';
import { Button, Card, CardTitle, Choice, errorText, Field, Notice, Screen, Text, useLoad, useTheme } from '../../src/ui';
import { Icon, IconRow, ModuleGate, useDebounced } from '../../src/ui/kit';

type Audience = { all: boolean; membershipIds: string[]; departmentIds: string[]; designationIds: string[]; groupIds: string[] };
type Draft = { id: string; subject: string; html: string; audience: Audience; cc: string[]; bcc: string[]; fileIds: string[] };

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Plain text typed on the phone as simple HTML paragraphs (the server keeps only safe formatting). */
const toHtml = (text: string) => text.split(/\n{2,}/).map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`).join('');
const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Write an email to employees: everyone or chosen people, CC and BCC, saved as a draft or sent now. */
function Compose() {
  const { draft } = useLocalSearchParams<{ draft?: string }>();
  const { api } = useSession();
  const router = useRouter();
  const t = useTheme();
  const [to, setTo] = useState<'all' | 'people'>('people');
  const [people, setPeople] = useState<Person[]>([]);
  const [keep, setKeep] = useState<Pick<Audience, 'departmentIds' | 'designationIds' | 'groupIds'> & { fileIds: string[] }>({ departmentIds: [], designationIds: [], groupIds: [], fileIds: [] });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [id, setId] = useState<string | null>(draft ?? null);
  const term = useDebounced(q.trim());
  const found = useLoad(() => (term.length >= 2 ? api.get<{ items: Person[] }>(`/communication/people?q=${encodeURIComponent(term)}`) : Promise.resolve({ items: [] })), [api, term]);

  // Opening a draft fills the form with it (people are shown by name from the people list).
  useEffect(() => {
    if (!draft) return;
    void (async () => {
      try {
        const d = await api.get<Draft>(`/communication/emails/${draft}`);
        setSubject(d.subject);
        setBody(htmlToText(d.html));
        setCc(d.cc.join(', '));
        setBcc(d.bcc.join(', '));
        setTo(d.audience.all ? 'all' : 'people');
        setKeep({ departmentIds: d.audience.departmentIds, designationIds: d.audience.designationIds, groupIds: d.audience.groupIds, fileIds: d.fileIds });
        if (d.audience.membershipIds.length) {
          const all = await api.get<{ items: Person[] }>('/communication/people');
          setPeople(all.items.filter((p) => d.audience.membershipIds.includes(p.membershipId)));
        }
      } catch (e) {
        setMsg({ tone: 'danger', text: errorText(e) });
      }
    })();
  }, [api, draft]);

  const payload = () => ({
    subject: subject.trim(),
    html: toHtml(body.trim()),
    audience: { all: to === 'all', membershipIds: to === 'all' ? [] : people.map((p) => p.membershipId), departmentIds: keep.departmentIds, designationIds: keep.designationIds, groupIds: keep.groupIds },
    cc: list(cc),
    bcc: list(bcc),
    fileIds: keep.fileIds,
  });
  const save = async () => {
    setBusy('draft');
    setMsg(null);
    try {
      const r = id ? await api.put<{ id: string }>(`/communication/emails/${id}`, payload()) : await api.post<{ id: string }>('/communication/emails', payload());
      setId(r.id);
      setMsg({ tone: 'ok', text: 'Draft saved.' });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const send = async () => {
    setBusy('send');
    setMsg(null);
    try {
      const r = await api.post<{ recipients: number }>(id ? `/communication/emails/${id}/send` : '/communication/emails/send', payload());
      setMsg({ tone: 'ok', text: `Sending to ${r.recipients} ${r.recipients === 1 ? 'address' : 'addresses'}.` });
      setTimeout(() => router.back(), 900);
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };
  const chosen = new Set(people.map((p) => p.membershipId));

  return (
    <Screen>
      {msg && <Notice tone={msg.tone} testID="compose-message">{msg.text}</Notice>}
      <Card>
        <CardTitle>To</CardTitle>
        <Choice<'all' | 'people'> value={to} onChange={setTo} options={[{ value: 'people', label: 'Chosen people' }, { value: 'all', label: 'Everyone' }]} />
        {to === 'people' && (
          <>
            {people.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} testID="compose-people">
                {people.map((p) => (
                  <Pressable key={p.membershipId} accessibilityRole="button" accessibilityLabel={`Remove ${p.name}`} onPress={() => setPeople(people.filter((x) => x.membershipId !== p.membershipId))} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, backgroundColor: t.infoBg, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text size={13} style={{ color: t.accent }}>{p.name}</Text>
                    <Icon name="close" size={14} color={t.accent} />
                  </Pressable>
                ))}
              </View>
            )}
            {keep.departmentIds.length + keep.designationIds.length + keep.groupIds.length > 0 && <Text muted size={13}>Also the departments, designations and groups chosen on the Web Portal.</Text>}
            <Field label="Add people" value={q} onChangeText={setQ} placeholder="Search by name" testID="compose-search" />
            {found.data?.items.filter((p) => !chosen.has(p.membershipId)).slice(0, 8).map((p) => (
              <IconRow key={p.membershipId} icon="person-add" tone="teal" title={p.name} subtitle={[p.designation, p.department].filter(Boolean).join(' · ') || undefined} onPress={() => { setPeople([...people, p]); setQ(''); }} />
            ))}
          </>
        )}
        <Field label="CC" value={cc} onChangeText={setCc} placeholder="Email addresses, separated by commas" autoCapitalize="none" keyboardType="email-address" />
        <Field label="BCC" value={bcc} onChangeText={setBcc} placeholder="Email addresses, separated by commas" autoCapitalize="none" keyboardType="email-address" />
      </Card>
      <Card>
        <Field label="Subject" value={subject} onChangeText={setSubject} maxLength={200} testID="compose-subject" />
        <Field label="Message" value={body} onChangeText={setBody} multiline numberOfLines={8} testID="compose-body" />
        {keep.fileIds.length > 0 && <Text muted size={13}>{`${keep.fileIds.length} attachment${keep.fileIds.length === 1 ? '' : 's'} from the draft will be sent.`}</Text>}
      </Card>
      <Button title="Send" onPress={send} busy={busy === 'send'} disabled={!!busy || !subject.trim() || !body.trim()} testID="compose-send" />
      <Button title="Save draft" kind="secondary" onPress={save} busy={busy === 'draft'} disabled={!!busy} testID="compose-save" />
    </Screen>
  );
}

export default function ComposeScreen() {
  return (
    <ModuleGate module="email" feature="compose">
      <Compose />
    </ModuleGate>
  );
}
