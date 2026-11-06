import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../src/lib/api';
import { randomId } from '../../src/lib/clock';
import { useSession } from '../../src/lib/session';
import type { Article, Category } from '../../src/lib/types';
import { Button, Card, Choice, Field, ListItem, Notice, Screen, Text, useLoad } from '../../src/ui';

export default function NewCase() {
  const { api } = useSession();
  const router = useRouter();
  const { data: categories, error: loadError } = useLoad(() => api.get<Category[]>('/helpdesk/categories'), [api]);
  const [categoryId, setCategoryId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high' | 'urgent'>('normal');
  const [articles, setArticles] = useState<Article[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(randomId());
  const category = categories?.find((c) => c.id === categoryId);

  // Suggest help articles that may already answer the question.
  useEffect(() => {
    if (!categoryId) return setArticles([]);
    const t = setTimeout(() => {
      const q = subject.trim().length >= 3 ? `&q=${encodeURIComponent(subject.trim())}` : '';
      api.get<Article[]>(`/helpdesk/articles?categoryId=${categoryId}${q}`).then((a) => setArticles(a.slice(0, 3)), () => setArticles([]));
    }, 400);
    return () => clearTimeout(t);
  }, [api, categoryId, subject]);

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!categoryId) errs.categoryId = 'Choose what your question is about';
    if (subject.trim().length < 3) errs.subject = 'Write a short subject (at least 3 characters)';
    if (description.trim().length < 10) errs.description = 'Describe your question (at least 10 characters)';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<{ id: string }>('/helpdesk/cases', { categoryId, subject: subject.trim(), description: description.trim(), priority }, key.current);
      router.replace(`/helpdesk/${c.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send your question.');
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {loadError && <Notice tone="danger">{loadError}</Notice>}
      {error && <Notice tone="danger" testID="case-error">{error}</Notice>}
      <Card>
        {categories && <Choice label="What is it about?" help="field.category" value={categoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} onChange={setCategoryId} />}
        {errors.categoryId && <Text size={13} style={{ color: '#b91c1c' }}>{errors.categoryId}</Text>}
        {category && (
          <Text muted size={13}>
            {`${category.description}${category.firstResponseHours ? ` HR aims to reply within ${category.firstResponseHours} hours.` : ''}${category.confidential ? ' Confidential: only the named HR handlers can see it.' : ''}`}
          </Text>
        )}
        <Field label="Subject" value={subject} onChangeText={setSubject} maxLength={200} error={errors.subject} />
        {articles.length > 0 && (
          <Notice tone="info">These help articles may answer it already:</Notice>
        )}
        {articles.map((a) => (
          <ListItem key={a.id} title={a.title} subtitle={a.excerpt} />
        ))}
        <Field label="Your question" value={description} onChangeText={setDescription} multiline maxLength={5000} error={errors.description} />
        <Choice label="How urgent is it?" help="field.priority" value={priority} onChange={setPriority} options={[{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }]} />
        <Button title="Send to HR" onPress={submit} busy={busy} testID="send-case" />
      </Card>
    </Screen>
  );
}
