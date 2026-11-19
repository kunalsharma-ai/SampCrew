import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { ApiError } from '../../src/lib/api';
import { taskStatusLabel, taskTone } from '../../src/lib/labels';
import { photoBytes, pickDocumentPhoto, type PickedPhoto } from '../../src/lib/photo';
import { useSession } from '../../src/lib/session';
import type { MyTask } from '../../src/lib/types';
import { Badge, Button, Card, CardTitle, Field, fmt, Loading, Notice, Row, Screen, Text, useLoad } from '../../src/ui';

const ACTION: Record<string, string> = {
  assigned: 'Assigned', edited: 'Edited', progress: 'Progress updated', acknowledged: 'Acknowledged', accepted: 'Accepted', reopened: 'Reopened', cancelled: 'Cancelled',
  uploaded: 'Document uploaded', document_verified: 'Document verified', document_rejected: 'Document rejected',
};

const FORMAT: Record<string, string> = { pdf: 'PDF', image: 'a photo (PNG, JPEG or WebP)', word: 'Word (.docx)', text: 'plain text' };

/** One task: what it asks for, and the step the person takes next (start, finish, acknowledge or upload). */
export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { data: task, error, reload } = useLoad(() => api.get<MyTask & { document: (MyTask['document'] & { verificationStatus?: string | null; verificationRemarks?: string | null }) | null }>(`/tasks/${id}`), [api, id]);
  const [remarks, setRemarks] = useState('');
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  // Opening a new task marks it as seen.
  useEffect(() => {
    if (task?.isMine && task.isNew) api.post(`/tasks/${task.id}/seen`, {}).catch(() => {});
  }, [api, task?.id, task?.isMine, task?.isNew]);

  const act = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: done });
      setRemarks('');
      setPhoto(null);
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  };

  if (!task) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Loading />}</Screen>;
  const closed = task.status === 'completed' || task.status === 'cancelled';
  const workable = task.isMine && !closed && task.status !== 'pending_review';
  const doc = task.document;
  const imagesAllowed = !doc || doc.spec.formats.includes('image');
  const progress = (status: string, done: string) => act(status, () => api.post(`/tasks/${task.id}/progress`, { status, remarks: remarks.trim() || null }), done);
  const pick = async (source: 'library' | 'camera') => {
    const r = await pickDocumentPhoto(source, (doc?.spec.maxMb ?? 5) * 1048576);
    if (r.ok) setPhoto(r.photo);
    else if (r.message) setMsg({ tone: 'danger', text: r.message });
  };
  const upload = () =>
    act('upload', async () => {
      const bytes = await photoBytes(photo!);
      if (!bytes.length) throw new Error('Could not read the picture. Choose it again.');
      await api.uploadFile('POST', `/tasks/${task.id}/document`, { field: 'file', fileName: photo!.fileName, type: photo!.mimeType, bytes, fields: remarks.trim() ? { remarks: remarks.trim() } : undefined });
    }, 'Uploaded. HR will verify it and you will be notified.');

  return (
    <Screen onRefresh={reload}>
      <Stack.Screen options={{ title: task.category === 'hr' ? 'HR task' : 'Manager task' }} />
      {msg && <Notice tone={msg.tone} testID="task-message">{msg.text}</Notice>}
      <Card testID="task-header">
        <Text size={18} weight="700">{task.title}</Text>
        <Row style={{ flexWrap: 'wrap' }}>
          <Badge tone={taskTone(task.displayStatus)}>{taskStatusLabel(task.displayStatus)}</Badge>
          {task.priority !== 'normal' && <Badge tone={task.priority === 'high' || task.priority === 'urgent' ? 'danger' : 'neutral'}>{`${task.priority[0]!.toUpperCase()}${task.priority.slice(1)} priority`}</Badge>}
          <Badge>{task.kind === 'document' ? 'Document' : task.kind === 'acknowledgement' ? 'Acknowledgement' : 'Task'}</Badge>
        </Row>
        <Text muted size={13}>{`From ${task.assignedBy ?? 'HR'} · ${fmt.date(task.assignedAt)}${task.dueOn ? ` · due ${fmt.date(task.dueOn)}` : ''}`}</Text>
        {task.description ? <Text>{task.description}</Text> : null}
        {task.reviewerRemarks && task.status === 'reopened' && <Notice tone="warn">{`Reopened: ${task.reviewerRemarks}`}</Notice>}
        {task.status === 'pending_review' && <Notice tone="info">{task.kind === 'document' ? 'HR is checking your document.' : 'Sent for review. You will be notified when it is accepted.'}</Notice>}
      </Card>

      {doc && (
        <Card testID="task-document">
          <CardTitle help="tasks.document">Document</CardTitle>
          <Text muted size={13}>{`Accepted: ${doc.spec.formats.map((f) => FORMAT[f] ?? f).join(', ')}, up to ${doc.spec.maxMb} MB.`}</Text>
          {doc.id && (
            <Row style={{ flexWrap: 'wrap' }}>
              <Text size={14}>{doc.fileName ?? 'Uploaded file'}</Text>
              {doc.verificationStatus && <Badge tone={doc.verificationStatus === 'verified' ? 'ok' : doc.verificationStatus === 'rejected' ? 'danger' : 'warn'}>{doc.verificationStatus === 'verified' ? 'Verified' : doc.verificationStatus === 'rejected' ? 'Rejected' : 'Waiting for HR'}</Badge>}
            </Row>
          )}
          {doc.verificationRemarks && <Text muted size={13}>{`HR: ${doc.verificationRemarks}`}</Text>}
          {workable && (imagesAllowed ? (
            <View style={{ gap: 8 }}>
              <Row>
                {Platform.OS !== 'web' && <Button kind="secondary" title="Take a photo" onPress={() => pick('camera')} testID="doc-camera" />}
                <Button kind="secondary" title="Choose a photo" onPress={() => pick('library')} testID="doc-library" />
              </Row>
              {photo && <Text size={13} testID="doc-picked">{`Ready to send: ${photo.fileName}`}</Text>}
              <Field label="Remarks (optional)" value={remarks} onChangeText={setRemarks} maxLength={2000} />
              <Button title={doc.id ? 'Upload again' : 'Upload'} disabled={!photo} busy={busy === 'upload'} onPress={upload} testID="doc-upload" />
            </View>
          ) : (
            <Notice tone="info">This task needs a PDF. Upload it from SampCrew on the web, under My tasks.</Notice>
          ))}
        </Card>
      )}

      {workable && task.kind !== 'document' && (
        <Card testID="task-actions">
          <CardTitle>Your update</CardTitle>
          <Field label={task.kind === 'acknowledgement' ? 'Comment (optional)' : 'What did you do? (optional)'} value={remarks} onChangeText={setRemarks} multiline maxLength={2000} />
          {task.status !== 'in_progress' && <Button kind="secondary" title="Start working on it" busy={busy === 'in_progress'} onPress={() => progress('in_progress', 'Marked as in progress.')} testID="task-start" />}
          {task.kind === 'acknowledgement' ? (
            <Button title="I have read and acknowledge this" busy={busy === 'completed'} onPress={() => progress('completed', 'Acknowledged.')} testID="task-ack" />
          ) : (
            <>
              <Button title="Send for review" busy={busy === 'pending_review'} onPress={() => progress('pending_review', 'Sent for review.')} testID="task-review" />
              <Button kind="secondary" title="Mark completed" busy={busy === 'completed'} onPress={() => progress('completed', 'Marked as completed.')} testID="task-complete" />
            </>
          )}
        </Card>
      )}

      <Card>
        <CardTitle>History</CardTitle>
        {task.history.slice().reverse().map((h, i) => (
          <View key={i} style={{ gap: 2 }}>
            <Text size={14} weight="600">{ACTION[h.action] ?? h.action}</Text>
            <Text muted size={12}>{`${h.by ?? 'SampCrew'} · ${fmt.dateTime(h.at)}${h.status ? ` · ${taskStatusLabel(h.status)}` : ''}`}</Text>
            {h.remarks ? <Text size={13}>{h.remarks}</Text> : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}
