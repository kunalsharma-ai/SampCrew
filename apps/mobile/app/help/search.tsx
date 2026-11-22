import { HELP_KIND_PLURAL, type HelpArticleKind, type HelpSearchResult } from '@crew/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useSession } from '../../src/lib/session';
import { Button, Card, Empty, Field, Notice, Screen, Text, useLoad } from '../../src/ui';
import { ArticleItem } from './index';

export default function HelpSearchScreen() {
  const { api } = useSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string; kind?: string; category?: string }>();
  const [q, setQ] = useState(params.q ?? '');
  const qs = new URLSearchParams(Object.entries({ q: params.q, kind: params.kind, category: params.category }).filter(([, v]) => v) as [string, string][]);
  const { data, error } = useLoad(() => api.get<HelpSearchResult>(`/help/search?${qs}`), [api, qs.toString()]);
  const title = params.q ? `Results for “${params.q}”` : params.kind ? HELP_KIND_PLURAL[params.kind as HelpArticleKind] : 'All articles';
  return (
    <Screen>
      <Card>
        <Field label="Search help" value={q} onChangeText={setQ} returnKeyType="search" onSubmitEditing={() => router.setParams({ q: q.trim() || undefined })} testID="help-search" />
        <Button title="Search" kind="secondary" onPress={() => router.setParams({ q: q.trim() || undefined })} />
      </Card>
      {error && <Notice tone="danger">{error}</Notice>}
      <Card testID="help-results">
        <Text weight="600">{title}</Text>
        <Text muted size={13}>{data ? `${data.total} ${data.total === 1 ? 'article' : 'articles'}` : 'Searching…'}</Text>
        {data?.items.map((a) => <ArticleItem key={a.id} a={a} />)}
        {data && !data.items.length && <Empty>Nothing matches. Try other words, or raise a query.</Empty>}
      </Card>
      <Button title="Raise a Query" kind="secondary" onPress={() => router.push('/help/ask')} />
    </Screen>
  );
}
