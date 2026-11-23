import { HELP_ICONS, type HelpArticleSummary, type HelpCategoryView, type HelpIcon } from '@crew/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSession } from '../../../src/lib/session';
import { Card, CardTitle, Empty, ListItem, Notice, Screen, Text, Title, useLoad } from '../../../src/ui';
import { ArticleItem } from '../index';

type Data = { category: HelpCategoryView; parent: HelpCategoryView | null; subcategories: HelpCategoryView[]; articles: HelpArticleSummary[] };

export default function HelpCategoryScreen() {
  const { api } = useSession();
  const router = useRouter();
  const { key } = useLocalSearchParams<{ key: string }>();
  const { data, error } = useLoad(() => api.get<Data>(`/help/categories/${encodeURIComponent(key ?? '')}`), [api, key]);
  return (
    <Screen>
      {error && <Notice tone="danger">{error}</Notice>}
      {data && (
        <>
          <Text size={32}>{HELP_ICONS[data.category.icon as HelpIcon] ?? '📘'}</Text>
          <Title>{data.category.name}</Title>
          {!!data.category.description && <Text muted>{data.category.description}</Text>}
          {data.subcategories.length > 0 && (
            <Card>
              <CardTitle>Topics</CardTitle>
              {data.subcategories.map((s) => <ListItem key={s.id} title={s.name} subtitle={`${s.count} articles`} onPress={() => router.push(`/help/category/${s.key}`)} />)}
            </Card>
          )}
          <Card testID="help-category-articles">
            <CardTitle>Articles</CardTitle>
            {data.articles.map((a) => <ArticleItem key={a.id} a={a} />)}
            {!data.articles.length && <Empty>No articles here yet.</Empty>}
          </Card>
        </>
      )}
    </Screen>
  );
}
