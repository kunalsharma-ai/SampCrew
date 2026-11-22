import type { HelpQueryCategoryView, HelpSettings } from '@crew/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ApiError } from '../../src/lib/api';
import { randomId } from '../../src/lib/clock';
import { photoBytes, pickDocumentPhoto } from '../../src/lib/photo';
import { useSession } from '../../src/lib/session';
import { Badge, Button, Card, CardTitle, Choice, Field, Notice, Row, Screen, Text, Title, useLoad } from '../../src/ui';

type Form = { categories: HelpQueryCategoryView[]; settings: HelpSettings; contact: { name: string; email: string | null; phone: string | null; levelLabel: string; workspace: string | null; routesTo: string } };
const MAX = 10 * 1024 * 1024;

/** Raise a Query from the phone: category (or Other), subject, description, the page, photos and contact details. */
export default function AskScreen() {
  const { api } = useSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ article?: string; page?: string }>();
  const { data: form, error: loadError } = useLoad(() => api.get<Form>('/help/queries/form'), [api]);
  const [category, setCategory] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [page, setPage] = useState(params.page ?? '');
  const [phone, setPhone] = useState<string | null>(null);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; ticketId: string; routeLabel: string } | null>(null);
  const key = useRef(randomId());

  const attach = async (source: 'library' | 'camera') => {
    setError(null);
    const r = await pickDocumentPhoto(source, MAX);
    if (!r.ok) { if (!r.cancelled && r.message) setError(r.message); return; }
    setBusy('attach');
    try {
      const bytes = await photoBytes(r.photo);
      const f = await api.uploadFile<{ id: string; name: string }>('POST', '/help/files', { field: 'file', fileName: r.photo.fileName, type: r.photo.mimeType, bytes });
      setFiles((cur) => [...cur, { id: f.id, name: f.name }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not attach the photo.');
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!category) errs.categoryKey = 'Choose a category, or Other';
    if (subject.trim().length < 5) errs.subject = 'Give your query a short subject (5 characters or more)';
    if (description.trim().length < 10) errs.description = 'Describe your question or problem in a sentence or two';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy('send');
    setError(null);
    try {
      const r = await api.post<{ id: string; ticketId: string; routeLabel: string }>('/help/queries', {
        categoryKey: category, subject: subject.trim(), description: description.trim(), page: page.trim() || null, articleId: params.article ?? null,
        contactPhone: (phone ?? form?.contact.phone ?? '').trim() || null, fileIds: files.map((f) => f.id), clientId: key.current,
      });
      setDone(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not raise your query.');
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <Screen>
        <Card testID="query-confirmation">
          <Text size={40}>✅</Text>
          <Title>Your query has been raised</Title>
          <Text muted>{`We sent it to ${done.routeLabel}. You will be notified of every reply.`}</Text>
          <Row style={{ gap: 8 }}><Text muted>Ticket ID</Text><Badge tone="info">{done.ticketId}</Badge></Row>
          <Button title="View the query" onPress={() => router.replace(`/help/queries/${done.id}`)} testID="query-open" />
          <Button title="Back to Help & Support" kind="secondary" onPress={() => router.replace('/help')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      {loadError && <Notice tone="danger">{loadError}</Notice>}
      {error && <Notice tone="danger" testID="query-error">{error}</Notice>}
      {form && (
        <>
          <Card>
            <Text muted size={13}>{`It goes to ${form.contact.routesTo}, unless the category says otherwise.`}</Text>
            <Choice label="What is it about?" value={category} options={form.categories.filter((c) => c.active).map((c) => ({ value: c.key, label: c.label }))} onChange={setCategory} />
            {errors.categoryKey && <Text size={13} style={{ color: '#b91c1c' }}>{errors.categoryKey}</Text>}
            <Field label="Subject" value={subject} onChangeText={setSubject} maxLength={150} error={errors.subject} testID="query-subject" />
            <Field label="Description" value={description} onChangeText={setDescription} multiline maxLength={5000} error={errors.description} hint="What you tried, what you expected and any error message." testID="query-description" />
            <Field label="Feature or page" value={page} onChangeText={setPage} maxLength={200} hint="For example: Leave, Apply for leave." />
            {form.settings.attachments && (
              <>
                <Row style={{ gap: 8 }}>
                  <Button title="Attach a photo" kind="secondary" busy={busy === 'attach'} disabled={files.length >= 5} onPress={() => void attach('library')} testID="query-attach" />
                  <Button title="Take a photo" kind="secondary" disabled={!!busy || files.length >= 5} onPress={() => void attach('camera')} />
                </Row>
                {files.map((f) => <Text key={f.id} muted size={13}>{`📎 ${f.name}`}</Text>)}
              </>
            )}
          </Card>
          <Card testID="query-contact">
            <CardTitle>Your contact details</CardTitle>
            <Text>{form.contact.name}</Text>
            <Text muted size={13}>{`${form.contact.levelLabel}${form.contact.workspace ? ` · ${form.contact.workspace}` : ''}`}</Text>
            <Text muted size={13}>{form.contact.email ?? ''}</Text>
            <Field label="Phone" value={phone ?? form.contact.phone ?? ''} onChangeText={setPhone} maxLength={30} keyboardType="phone-pad" />
          </Card>
          <Button title="Submit query" onPress={() => void submit()} busy={busy === 'send'} testID="query-submit" />
        </>
      )}
    </Screen>
  );
}
