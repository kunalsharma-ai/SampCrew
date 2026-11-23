import { DOCUMENT_CATEGORIES } from '@crew/contracts';
import { useState } from 'react';
import { useMobileApp } from '../../src/lib/mobile-app';
import { openSigned } from '../../src/lib/open';
import { photoBytes, pickFile, type PickedPhoto } from '../../src/lib/photo';
import { useSession } from '../../src/lib/session';
import type { EmployeeDocument } from '../../src/lib/types';
import { Badge, Button, Card, CardTitle, Choice, errorText, Field, fmt, Notice, Screen, Text, useLoad, useReloadOnFocus } from '../../src/ui';
import { EmptyState, IconRow, ModuleGate, Section, SkeletonCard } from '../../src/ui/kit';

type Category = (typeof DOCUMENT_CATEGORIES)[number];
const CATEGORY: Record<Category, string> = {
  id_proof: 'ID proof', address_proof: 'Address proof', contract: 'Contract', offer_letter: 'Offer letter', policy: 'Policy', certificate: 'Certificate', tax: 'Tax', other: 'Other',
};
const UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'];
const MAX_BYTES = 10 * 1024 * 1024;
const iconFor = (type: string) => (type.startsWith('image/') ? 'image' : type === 'application/pdf' ? 'document-text' : type.includes('sheet') || type.includes('excel') ? 'grid' : 'document');
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** The person's own documents by category: open through a short-lived audited link, and upload where allowed. */
function Documents() {
  const { api, me, can } = useSession();
  const { has } = useMobileApp();
  const employeeId = me?.employee?.id;
  const uploadOn = has('documents.upload') && can('documents:manage');
  const downloadOn = has('documents.download');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [file, setFile] = useState<PickedPhoto | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('other');
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(
    () => (employeeId ? api.get<EmployeeDocument[]>(`/employees/${employeeId}/documents`) : Promise.resolve([])),
    [api, employeeId],
    employeeId ? api.peek<EmployeeDocument[]>(`/employees/${employeeId}/documents`) : null,
  );
  useReloadOnFocus(reload);

  if (!employeeId) {
    return (
      <Screen>
        <EmptyState icon="document-text" tone="pink" title="No employee record" body="Documents belong to an employee record, and your sign-in is not linked to one." />
      </Screen>
    );
  }
  const open = (d: EmployeeDocument) => void openSigned(api, `/documents/${d.id}/link`).catch((e) => setMsg({ tone: 'danger', text: errorText(e) }));
  const choose = async () => {
    const r = await pickFile(UPLOAD_TYPES, MAX_BYTES, 'PDF, Word, Excel, JPG, PNG or text');
    if (r.ok) {
      setFile(r.photo);
      if (!title) setTitle(r.photo.fileName.replace(/\.[^.]+$/, ''));
    } else if (r.message) setMsg({ tone: 'danger', text: r.message });
  };
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const bytes = await photoBytes(file);
      await api.uploadFile('POST', `/employees/${employeeId}/documents`, { field: 'file', fileName: file.fileName, type: file.mimeType, bytes, fields: { category, title: title.trim() || file.fileName, visibility: 'employee' } });
      setFile(null);
      setTitle('');
      setMsg({ tone: 'ok', text: 'Uploaded to your record.' });
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const groups = DOCUMENT_CATEGORIES.map((c) => ({ c, docs: (data ?? []).filter((d) => d.category === c) })).filter((g) => g.docs.length);

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {msg && <Notice tone={msg.tone} testID="documents-message">{msg.text}</Notice>}
      {error && <Notice tone={data ? 'warn' : 'danger'}>{error}</Notice>}
      {!data && !error && <SkeletonCard lines={4} />}
      {data && data.length === 0 && <EmptyState icon="folder-open" tone="pink" title="No documents yet" body="Documents HR adds to your record, such as your offer letter or contract, show here." />}
      {groups.map((g) => (
        <Card key={g.c} testID={`documents-${g.c}`}>
          <Section title={CATEGORY[g.c]} />
          {g.docs.map((d) => (
            <IconRow
              key={d.id}
              icon={iconFor(d.contentType)}
              tone="pink"
              title={d.title}
              subtitle={`${d.fileName} · ${size(d.sizeBytes)} · ${fmt.date(d.createdAt)}`}
              right={d.verificationStatus ? <Badge tone={d.verificationStatus === 'verified' ? 'ok' : d.verificationStatus === 'rejected' ? 'danger' : 'warn'}>{d.verificationStatus === 'verified' ? 'Verified' : d.verificationStatus === 'rejected' ? 'Rejected' : 'Waiting for HR'}</Badge> : undefined}
              onPress={downloadOn ? () => open(d) : undefined}
            />
          ))}
        </Card>
      ))}
      {data && data.length > 0 && !downloadOn && <Text muted size={13}>Opening documents is not available in the app. Use the Web Portal to download them.</Text>}
      {uploadOn && (
        <Card testID="documents-upload">
          <CardTitle>Upload a document</CardTitle>
          <Button title={file ? `Chosen: ${file.fileName}` : 'Choose a file'} kind="secondary" onPress={choose} />
          {file && (
            <>
              <Field label="Title" value={title} onChangeText={setTitle} maxLength={200} />
              <Choice<Category> label="Category" value={category} onChange={setCategory} options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY[c] }))} />
              <Button title="Upload" onPress={upload} busy={busy} />
            </>
          )}
        </Card>
      )}
    </Screen>
  );
}

export default function DocumentsScreen() {
  return (
    <ModuleGate module="documents">
      <Documents />
    </ModuleGate>
  );
}
